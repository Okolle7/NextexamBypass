const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');

let win = null;
let claudeWin = null;
let hook = null;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function loadHook() {
    try {
        hook = require('./build/Release/keyboardhook.node');
        return true;
    } catch (e) {
        console.error('[overlay] failed to load keyboardhook:', e.message);
        return false;
    }
}

function pushOverlayBounds() {
    if (!hook || !hook.setOverlayBounds) return;
    hook.setOverlayBounds(-1000000, -1000000, 2000000, 2000000);
}

function createWindow() {
    win = new BrowserWindow({
        width: 700,
        height: 450,
        x: 50,
        y: 50,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: true,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile('overlay.html');

    win.showInactive();
    win.setContentProtection(true);

    win.webContents.once('did-finish-load', () => {
        win.setContentProtection(true);
        pushOverlayBounds();
    });

    win.on('move', pushOverlayBounds);
    win.on('resize', pushOverlayBounds);

    win.on('close', (e) => {
        e.preventDefault();
        win.hide();
    });
}

function createClaudeWindow() {
    claudeWin = new BrowserWindow({
        width: 900,
        height: 700,
        show: false,
        frame: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'claudepreload.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            partition: 'persist:claude'
        }
    });

    claudeWin.webContents.setUserAgent(CHROME_UA);

    claudeWin.webContents.on('render-process-gone', (e, d) => {
        console.error('[claude] renderer crashed:', d.reason);
        claudeWin.webContents.reload();
    });

    claudeWin.loadURL('https://claude.ai/new', { userAgent: CHROME_UA });

    claudeWin.once('ready-to-show', () => {
        claudeWin.setContentProtection(true);
    });

    claudeWin.on('close', (e) => {
        e.preventDefault();
        claudeWin.hide();
    });
}

function toggleClaudeWindow() {
    if (!claudeWin) return;
    if (claudeWin.isVisible()) {
        claudeWin.hide();
        if (hook && hook.restoreForeground) hook.restoreForeground();
    } else {
        if (hook && hook.rememberForeground) hook.rememberForeground();
        claudeWin.show();
        claudeWin.setContentProtection(true);
        claudeWin.focus();
    }
}

function setupClaudeBridge() {
    ipcMain.on('ask-claude', (e, text) => {
        if (claudeWin) claudeWin.webContents.send('send-prompt', text);
    });
    ipcMain.on('claude-chunk', (e, text) => {
        if (win) win.webContents.send('claude-reply', { text, done: false });
    });
    ipcMain.on('claude-done', (e, text) => {
        if (win) win.webContents.send('claude-reply', { text, done: true });
    });
    ipcMain.on('claude-not-ready', () => {
        if (win) win.webContents.send('claude-reply', { notReady: true });
    });
    ipcMain.on('claude-error', (e, msg) => {
        if (win) win.webContents.send('claude-reply', { error: msg });
    });
    ipcMain.on('claude-ready', (e, ok) => {
        if (win) win.webContents.send('claude-reply', { ready: ok });
    });

    ipcMain.on('overlay-interactive', () => {
        if (!win) return;
        win.setIgnoreMouseEvents(true, { forward: true });
    });
}

function setupHook() {
    if (!hook) return;

    hook.startMessageLoop();

    hook.install((vkCode, isDown, text) => {
        if (vkCode === 0x2D) {
            if (win) {
                if (win.isVisible()) {
                    win.hide();
                    hook.setOverlayVisible(false);
                    hook.setCaptureMode(false);
                    win.webContents.send('hook-toggle', 'off');
                    if (hook.restoreForeground) hook.restoreForeground();
                } else {
                    if (hook.rememberForeground) hook.rememberForeground();
                    win.showInactive();
                    win.setAlwaysOnTop(true, 'screen-saver');
                    win.setContentProtection(true);
                    hook.setOverlayVisible(true);
                }
            }
            return;
        }
        if (vkCode === 0xBF) {
            if (win && win.webContents) {
                win.webContents.send('hook-toggle', hook.isCaptureMode() ? 'ON' : 'OFF');
            }
            return;
        }
        if (win && win.webContents && hook.isCaptureMode()) {
            win.webContents.send('hook-key', { vk: vkCode, down: isDown, text });
        }
    });

    hook.setOverlayVisible(win ? win.isVisible() : false);

    if (hook.installMouse) {
        hook.installMouse((delta) => {
            if (!win || win.isDestroyed() || !win.webContents || !win.isVisible()) return;
            const c = screen.getCursorScreenPoint();
            const b = win.getBounds();
            const inside = (c.x >= b.x && c.x < b.x + b.width &&
                            c.y >= b.y && c.y < b.y + b.height);
            if (!inside) return;
            win.webContents.executeJavaScript(
                `(() => { const e = document.querySelector('#answer'); if (e) e.scrollTop -= ${delta}; })();`,
                true
            ).catch(() => {});
        });
        pushOverlayBounds();
    }
}

app.on('browser-window-created', (e, window) => {
    window.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Insert') {
            event.preventDefault();
        }
    });
});

app.whenReady().then(() => {
    createWindow();
    createClaudeWindow();
    setupClaudeBridge();

    globalShortcut.register('Control+Shift+C', toggleClaudeWindow);

    if (loadHook()) {
        setTimeout(setupHook, 500);
    }
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (hook) {
        try { hook.uninstall(); if (hook.uninstallMouse) hook.uninstallMouse(); hook.stopMessageLoop(); } catch (e) {}
    }
});