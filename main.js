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
    });

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

    claudeWin.webContents.on('render-process-gone', (e, details) => {
        console.error('[claude] renderer crashed:', details.reason);
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
    if (claudeWin.isVisible()) {
        claudeWin.hide();
        if (hook) hook.restoreForeground();
    } else {
        if (hook) hook.rememberForeground();
        claudeWin.show();
        claudeWin.setContentProtection(true);
        claudeWin.focus();
    }
}

function setupClaudeBridge() {
    const toOverlay = (data) => win.webContents.send('claude-reply', data);

    ipcMain.on('ask-claude', (e, text) => claudeWin.webContents.send('send-prompt', text));
    ipcMain.on('claude-chunk', (e, text) => toOverlay({ text, done: false }));
    ipcMain.on('claude-done', (e, text) => toOverlay({ text, done: true }));
    ipcMain.on('claude-not-ready', () => toOverlay({ notReady: true }));
    ipcMain.on('claude-error', (e, msg) => toOverlay({ error: msg }));
    ipcMain.on('claude-ready', (e, ok) => toOverlay({ ready: ok }));
}

function setupHook() {
    hook.startMessageLoop();

    hook.install((vk, down, text) => {
        if (vk === 0x2D) { // Insert
            if (win.isVisible()) {
                win.hide();
                hook.setOverlayVisible(false);
                hook.setCaptureMode(false);
                win.webContents.send('hook-toggle', 'off');
                hook.restoreForeground();
            } else {
                hook.rememberForeground();
                win.showInactive();
                win.setAlwaysOnTop(true, 'screen-saver');
                win.setContentProtection(true);
                hook.setOverlayVisible(true);
            }
            return;
        }
        // the native side already flipped capture mode, just tell the overlay
        if (vk === 0xBF) {
            win.webContents.send('hook-toggle', hook.isCaptureMode() ? 'ON' : 'OFF');
            return;
        }
        if (hook.isCaptureMode()) {
            win.webContents.send('hook-key', { vk, down, text });
        }
    });

    hook.setOverlayVisible(win.isVisible());

    hook.installMouse((delta) => {
        if (win.isDestroyed() || !win.isVisible()) return;
        const c = screen.getCursorScreenPoint();
        const b = win.getBounds();
        if (c.x < b.x || c.x >= b.x + b.width || c.y < b.y || c.y >= b.y + b.height) return;
        win.webContents.executeJavaScript(`document.getElementById('answer').scrollTop -= ${delta}`, true)
            .catch(() => {});
    });
    // the native rect only has to be set, the real hit test is the bounds check above
    hook.setOverlayBounds(-1000000, -1000000, 2000000, 2000000);
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
    if (!hook) return;
    hook.uninstall();
    hook.uninstallMouse();
    hook.stopMessageLoop();
});
