const { ipcRenderer } = require('electron');

// claude.ai changes its markup every few weeks, so each entry has backups. first match wins
const SEL = {
    editor: [
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"]'
    ],
    send: [
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
        'button[data-testid="send-button"]'
    ],
    stop: [
        'button[aria-label="Stop response"]',
        'button[aria-label*="Stop" i]',
        'button[data-testid="stop-button"]'
    ],
    message: [
        'div.font-claude-message',
        '[data-testid="assistant-message"]'
    ]
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(list) {
    for (const s of list) {
        const el = document.querySelector(s);
        if (el) return el;
    }
    return null;
}

function pickAll(list) {
    for (const s of list) {
        const els = document.querySelectorAll(s);
        if (els.length) return els;
    }
    return [];
}

function loggedIn() {
    return !!pick(SEL.editor);
}

function proseText(el) {
    const sel = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote';
    const all = Array.from(el.querySelectorAll(sel))
        .filter((n) => !n.closest('.sr-only, [aria-hidden="true"]'));
    // drop matches nested in another match (p inside li) or the text shows up twice
    const top = all.filter((n) => !all.some((m) => m !== n && m.contains(n)));
    return top.map((n) => n.innerText.trim()).filter(Boolean).join('\n');
}

function lastMessageEl() {
    const msgs = pickAll(SEL.message);
    return msgs.length ? msgs[msgs.length - 1] : null;
}

function setEditorText(text) {
    const ed = pick(SEL.editor);
    if (!ed) return false;
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    // ProseMirror ignores direct DOM edits, insertText goes through its input handling
    document.execCommand('insertText', false, text);
    return true;
}

async function clickSend() {
    // button stays disabled for a moment after the text goes in
    for (let i = 0; i < 25; i++) {
        const btn = pick(SEL.send);
        if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return true;
        }
        await sleep(100);
    }
    // never got a clickable button, try pressing enter instead
    const ed = pick(SEL.editor);
    if (ed) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
            ed.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
            }));
        }
        return true;
    }
    return false;
}

async function ask(text) {
    if (!loggedIn()) {
        ipcRenderer.send('claude-not-ready');
        return;
    }

    const before = pickAll(SEL.message).length;

    if (!setEditorText(text)) {
        ipcRenderer.send('claude-error', 'input field not found');
        return;
    }
    await sleep(150);
    if (!(await clickSend())) {
        ipcRenderer.send('claude-error', 'could not send message');
        return;
    }

    const deadline = Date.now() + 20000;
    while (pickAll(SEL.message).length <= before && !pick(SEL.stop)) {
        if (Date.now() > deadline) {
            ipcRenderer.send('claude-error', 'no response');
            return;
        }
        await sleep(150);
    }

    let last = '';
    let stableSince = 0;
    const hardLimit = Date.now() + 240000;
    while (Date.now() < hardLimit) {
        const el = lastMessageEl();
        const cur = el ? proseText(el) : '';
        if (cur && cur !== last) {
            last = cur;
            stableSince = 0;
            ipcRenderer.send('claude-chunk', cur);
        }
        // the stop button goes away slightly before the last chunk renders,
        // so wait until the text hasn't changed for a bit
        const generating = !!pick(SEL.stop);
        if (!generating && last) {
            if (stableSince === 0) stableSince = Date.now();
            else if (Date.now() - stableSince > 900) break;
        } else {
            stableSince = 0;
        }
        await sleep(200);
    }

    ipcRenderer.send('claude-done', last);
}

ipcRenderer.on('send-prompt', (e, text) => { ask(text); });

window.addEventListener('load', () => {
    setTimeout(() => ipcRenderer.send('claude-ready', loggedIn()), 1500);
});