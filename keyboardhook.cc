#include <napi.h>
#include <windows.h>
#include <thread>
#include <atomic>
#include <string>

static HHOOK g_hook = nullptr;
static napi_threadsafe_function g_tsfn = nullptr;
// capture mode: keys go to the overlay instead of the focused app
static std::atomic<bool> g_capture_mode{false};
static std::atomic<bool> g_overlay_visible{false};
static HWND g_prev_foreground = nullptr;

static HHOOK g_mouse_hook = nullptr;
static napi_threadsafe_function g_mouse_tsfn = nullptr;
// overlay rect in screen coords, set from JS and read in the mouse hook
static std::atomic<LONG> g_ov_l{0};
static std::atomic<LONG> g_ov_t{0};
static std::atomic<LONG> g_ov_r{0};
static std::atomic<LONG> g_ov_b{0};
static std::atomic<bool> g_ov_bounds_valid{false};

struct KeyEvent {
    int vkCode;
    bool isDown;
    std::wstring text;
};

// our own copy of the modifier/toggle state, fed from the hook stream below.
// the hook thread never gets these keys in its own queue, so GetKeyboardState
// would report nothing useful here
static BYTE g_kbd[256] = {0};

static void SyncModifier(BYTE generic, BYTE left, BYTE right) {
    g_kbd[generic] = (g_kbd[left] | g_kbd[right]) & 0x80;
}

static void TrackKeyState(DWORD vk, bool down) {
    if (vk > 0xFF) return;

    bool isToggle = (vk == VK_CAPITAL || vk == VK_NUMLOCK || vk == VK_SCROLL);
    BYTE toggled = isToggle ? (g_kbd[vk] & 0x01) : 0;
    if (isToggle && down) toggled ^= 0x01;
    g_kbd[vk] = (down ? 0x80 : 0x00) | toggled;

    // a low level hook reports the left/right vk, layouts read the generic one
    switch (vk) {
        case VK_LSHIFT:
        case VK_RSHIFT:
            SyncModifier(VK_SHIFT, VK_LSHIFT, VK_RSHIFT);
            break;
        case VK_LCONTROL:
        case VK_RCONTROL:
            SyncModifier(VK_CONTROL, VK_LCONTROL, VK_RCONTROL);
            break;
        case VK_LMENU:
        case VK_RMENU:
            SyncModifier(VK_MENU, VK_LMENU, VK_RMENU);
            break;
    }
}

static void SeedKeyState() {
    const BYTE held[] = { VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_CONTROL, VK_LCONTROL,
                          VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU };
    for (BYTE vk : held) {
        g_kbd[vk] = (GetAsyncKeyState(vk) & 0x8000) ? 0x80 : 0x00;
    }
    const BYTE toggles[] = { VK_CAPITAL, VK_NUMLOCK, VK_SCROLL };
    for (BYTE vk : toggles) {
        g_kbd[vk] = (BYTE)(GetKeyState(vk) & 0x01);
    }
}

// follow whatever layout the focused window uses, so switching layout just works
static HKL ActiveLayout() {
    HWND fg = GetForegroundWindow();
    DWORD tid = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
    return GetKeyboardLayout(tid);
}

// let the layout decide what the key produces: shifted characters, AltGr
// combinations and dead key composition all come out of ToUnicodeEx
static std::wstring TranslateKey(DWORD vk, DWORD scanCode) {
    bool ctrl = (g_kbd[VK_CONTROL] & 0x80) != 0;
    bool alt = (g_kbd[VK_MENU] & 0x80) != 0;
    // plain ctrl maps to control chars, but AltGr comes through as ctrl+alt
    if (ctrl && !alt) return L"";

    wchar_t buf[8];
    int n = ToUnicodeEx(vk, scanCode, g_kbd, buf, 8, 0, ActiveLayout());
    // 0 means no character, negative means a dead key is now pending
    if (n <= 0) return L"";
    return std::wstring(buf, n);
}

// runs on the JS thread. ev was allocated in SendKey and has to be freed
// even when env is null (node is shutting down)
static void CallJs(napi_env env, napi_value js_cb, void*, void* data) {
    KeyEvent* ev = static_cast<KeyEvent*>(data);
    if (env) {
        napi_value undefined, vk, down, text;
        napi_get_undefined(env, &undefined);
        napi_create_int32(env, ev->vkCode, &vk);
        napi_get_boolean(env, ev->isDown, &down);
        napi_create_string_utf16(env, (const char16_t*)ev->text.c_str(),
                                 ev->text.size(), &text);
        napi_value argv[3] = { vk, down, text };
        napi_call_function(env, undefined, js_cb, 3, argv, nullptr);
    }
    delete ev;
}

// the hook only runs between Install and Uninstall so g_tsfn is always set here
static void SendKey(DWORD vk, bool down, std::wstring text = L"") {
    napi_call_threadsafe_function(g_tsfn, new KeyEvent{ (int)vk, down, std::move(text) },
                                  napi_tsfn_nonblocking);
}

static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION) {
        KBDLLHOOKSTRUCT* kb = (KBDLLHOOKSTRUCT*)lParam;
        bool isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);

        TrackKeyState(kb->vkCode, isDown);

        // Insert toggles the overlay, always eat it so other apps never see it.
        // returning 1 from a LL hook drops the key
        if (kb->vkCode == VK_INSERT) {
            if (isDown) SendKey(kb->vkCode, true);
            return 1;
        }

        if (!g_overlay_visible.load()) {
            return CallNextHookEx(g_hook, nCode, wParam, lParam);
        }

        // # key on a german layout
        if (kb->vkCode == VK_OEM_2) {
            if (isDown) {
                g_capture_mode.store(!g_capture_mode.load());
                SendKey(kb->vkCode, true);
            }
            return 1;
        }

        if (g_capture_mode.load()) {
            // only a press produces a character, and translating a release
            // would disturb a pending dead key
            SendKey(kb->vkCode, isDown,
                    isDown ? TranslateKey(kb->vkCode, kb->scanCode) : L"");
            return 1;
        }
    }
    return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

struct WheelEvent {
    int delta;
};

static void CallMouseJs(napi_env env, napi_value js_cb, void*, void* data) {
    WheelEvent* ev = static_cast<WheelEvent*>(data);
    if (env) {
        napi_value undefined, d;
        napi_get_undefined(env, &undefined);
        napi_create_int32(env, ev->delta, &d);
        napi_value argv[1] = { d };
        napi_call_function(env, undefined, js_cb, 1, argv, nullptr);
    }
    delete ev;
}

static LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION && wParam == WM_MOUSEWHEEL) {
        MSLLHOOKSTRUCT* ms = (MSLLHOOKSTRUCT*)lParam;
        if (g_overlay_visible.load() && g_capture_mode.load() && g_ov_bounds_valid.load()) {
            LONG x = ms->pt.x;
            LONG y = ms->pt.y;
            if (x >= g_ov_l.load() && x < g_ov_r.load() &&
                y >= g_ov_t.load() && y < g_ov_b.load()) {
                // wheel delta is the signed high word, +120 per notch up
                int delta = (short)HIWORD(ms->mouseData);
                napi_call_threadsafe_function(g_mouse_tsfn, new WheelEvent{ delta }, napi_tsfn_nonblocking);
                return 1;
            }
        }
    }
    return CallNextHookEx(g_mouse_hook, nCode, wParam, lParam);
}

static Napi::Value Install(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected a callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    napi_value resourceName;
    napi_create_string_utf8(env, "KeyboardHook", NAPI_AUTO_LENGTH, &resourceName);

    napi_status status = napi_create_threadsafe_function(
        env, info[0], nullptr, resourceName, 0, 1,
        nullptr, nullptr, nullptr, CallJs, &g_tsfn);

    if (status != napi_ok) {
        Napi::Error::New(env, "Failed to create keyboard callback")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    SeedKeyState();

    g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc,
                               GetModuleHandleW(nullptr), 0);

    return Napi::Boolean::New(env, g_hook != nullptr);
}

static Napi::Value Uninstall(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_hook) {
        UnhookWindowsHookEx(g_hook);
        g_hook = nullptr;
    }
    if (g_tsfn) {
        napi_release_threadsafe_function(g_tsfn, napi_tsfn_release);
        g_tsfn = nullptr;
    }
    return env.Undefined();
}

static Napi::Value SetCaptureMode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() >= 1 && info[0].IsBoolean()) {
        g_capture_mode.store(info[0].As<Napi::Boolean>().Value());
    }
    return env.Undefined();
}

static Napi::Value IsCaptureMode(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_capture_mode.load());
}

static Napi::Value SetOverlayVisible(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() >= 1 && info[0].IsBoolean()) {
        g_overlay_visible.store(info[0].As<Napi::Boolean>().Value());
    }
    return env.Undefined();
}

static Napi::Value RememberForeground(const Napi::CallbackInfo& info) {
    g_prev_foreground = GetForegroundWindow();
    return info.Env().Undefined();
}

static Napi::Value RestoreForeground(const Napi::CallbackInfo& info) {
    if (g_prev_foreground && IsWindow(g_prev_foreground)) {
        SetForegroundWindow(g_prev_foreground);
    }
    g_prev_foreground = nullptr;
    return info.Env().Undefined();
}

static Napi::Value InstallMouse(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected a callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    napi_value resourceName;
    napi_create_string_utf8(env, "MouseHook", NAPI_AUTO_LENGTH, &resourceName);
    napi_status status = napi_create_threadsafe_function(
        env, info[0], nullptr, resourceName, 0, 1,
        nullptr, nullptr, nullptr, CallMouseJs, &g_mouse_tsfn);
    if (status != napi_ok) {
        Napi::Error::New(env, "Failed to create mouse callback")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    g_mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, LowLevelMouseProc,
                                     GetModuleHandleW(nullptr), 0);
    return Napi::Boolean::New(env, g_mouse_hook != nullptr);
}

static Napi::Value UninstallMouse(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_mouse_hook) {
        UnhookWindowsHookEx(g_mouse_hook);
        g_mouse_hook = nullptr;
    }
    if (g_mouse_tsfn) {
        napi_release_threadsafe_function(g_mouse_tsfn, napi_tsfn_release);
        g_mouse_tsfn = nullptr;
    }
    return env.Undefined();
}

static Napi::Value SetOverlayBounds(const Napi::CallbackInfo& info) {
    if (info.Length() >= 4) {
        LONG x = info[0].As<Napi::Number>().Int32Value();
        LONG y = info[1].As<Napi::Number>().Int32Value();
        LONG w = info[2].As<Napi::Number>().Int32Value();
        LONG h = info[3].As<Napi::Number>().Int32Value();
        // store right/bottom so the hook only has to compare
        g_ov_l.store(x);
        g_ov_t.store(y);
        g_ov_r.store(x + w);
        g_ov_b.store(y + h);
        g_ov_bounds_valid.store(true);
    }
    return info.Env().Undefined();
}

static std::thread g_msg_thread;
static std::atomic<bool> g_msg_running{false};
static std::atomic<DWORD> g_msg_thread_id{0};

static void message_loop() {
    g_msg_thread_id.store(GetCurrentThreadId());
    MSG msg;
    while (g_msg_running.load() && GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

static Napi::Value StartMessageLoop(const Napi::CallbackInfo& info) {
    if (g_msg_running.load()) return info.Env().Undefined();
    g_msg_running.store(true);
    g_msg_thread = std::thread(message_loop);
    return info.Env().Undefined();
}

static Napi::Value StopMessageLoop(const Napi::CallbackInfo& info) {
    g_msg_running.store(false);
    if (g_msg_thread.joinable()) {
        // GetMessageW blocks so the flag alone won't stop it. WM_QUIT wakes it up
        DWORD tid = g_msg_thread_id.load();
        if (tid != 0) {
            PostThreadMessageW(tid, WM_QUIT, 0, 0);
        }
        g_msg_thread.join();
    }
    return info.Env().Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("install", Napi::Function::New(env, Install));
    exports.Set("uninstall", Napi::Function::New(env, Uninstall));
    exports.Set("setCaptureMode", Napi::Function::New(env, SetCaptureMode));
    exports.Set("isCaptureMode", Napi::Function::New(env, IsCaptureMode));
    exports.Set("setOverlayVisible", Napi::Function::New(env, SetOverlayVisible));
    exports.Set("rememberForeground", Napi::Function::New(env, RememberForeground));
    exports.Set("restoreForeground", Napi::Function::New(env, RestoreForeground));
    exports.Set("installMouse", Napi::Function::New(env, InstallMouse));
    exports.Set("uninstallMouse", Napi::Function::New(env, UninstallMouse));
    exports.Set("setOverlayBounds", Napi::Function::New(env, SetOverlayBounds));
    exports.Set("startMessageLoop", Napi::Function::New(env, StartMessageLoop));
    exports.Set("stopMessageLoop", Napi::Function::New(env, StopMessageLoop));
    return exports;
}

NODE_API_MODULE(keyboardhook, Init)
