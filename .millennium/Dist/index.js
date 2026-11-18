/**
 * Steam Epic Integration — Frontend
 * Uses Steam's native ContextMenuManager (bForcePopup: true) so the Epic dropdown
 * opens in a genuine OS/CEF popup window — identical to Steam's Account and Notifications
 * menus. It is never overlapped by the Store/Community BrowserView, automatically
 * repositions, closes on outside click/blur/Escape, and integrates cleanly into TitleBarControls.
 */

const PLUGIN_NAME = "steam-epic-integration";
const LOCAL_DAEMON_URL = "http://127.0.0.1:49812";
const STORAGE_KEY_SYNC = "se_epic_library_enabled";
const STORAGE_KEY_APPIDS = "se_epic_shortcut_appids";

async function callBackend(method, args = {}) {
    if (window.Millennium && typeof window.Millennium.callServerMethod === "function") {
        try {
            const raw = await window.Millennium.callServerMethod(PLUGIN_NAME, method, args);
            let parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (parsed && typeof parsed.value === "string") {
                parsed = JSON.parse(parsed.value);
            } else if (typeof parsed === "string") {
                parsed = JSON.parse(parsed);
            }
            return parsed;
        } catch (_) {}
    }
    const resp = await fetch(`${LOCAL_DAEMON_URL}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    return await resp.json();
}

const STEAM_BUTTON_CSS = `
.se-top-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 10px;
    margin-right: 6px;
    background: #23262e;
    border: 1px solid #323844;
    color: #dcdedf;
    border-radius: 2px;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    user-select: none;
    transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    -webkit-app-region: no-drag;
    box-sizing: border-box;
    position: relative;
}
.se-top-btn:hover, .se-top-btn.se-active {
    background: #3d4450;
    border-color: #66c0f4;
    color: #ffffff;
}
.se-badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #66c0f4;
    box-shadow: 0 0 6px #66c0f4;
    display: none;
}
.se-badge-dot.se-visible {
    display: inline-block;
}
`;

const STEAM_POPUP_CSS = `
.se-popup-root {
    width: 340px;
    background: #171d25;
    border: 1px solid #2a313c;
    color: #dcdedf;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    user-select: none;
}
.se-header-panel {
    background: #10151b;
    padding: 10px 12px;
    border-bottom: 1px solid #232933;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.se-account-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.se-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #1b222c;
    padding: 7px 10px;
    border-radius: 2px;
    border: 1px solid #262f3d;
    gap: 8px;
}
.se-switch {
    position: relative;
    width: 34px;
    height: 18px;
    background: #323844;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.15s ease;
    flex-shrink: 0;
}
.se-switch.se-on {
    background: #1a9fff;
}
.se-switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: #ffffff;
    border-radius: 50%;
    transition: transform 0.15s ease;
}
.se-switch.se-on::after {
    transform: translateX(16px);
}
.se-body {
    padding: 10px 12px;
    max-height: 370px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.se-section-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: #66c0f4;
    font-weight: 600;
}
.se-card {
    background: #23262e;
    border: 1px solid #2d333d;
    border-radius: 2px;
    overflow: hidden;
}
.se-card img {
    width: 100%;
    height: 118px;
    object-fit: cover;
    display: block;
    background: #0e1217;
}
.se-card-info {
    padding: 8px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.se-card-title {
    font-size: 13px;
    color: #ffffff;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.se-btn {
    background: #3d4450;
    color: #dcdedf;
    border: none;
    border-radius: 2px;
    padding: 5px 10px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.12s ease, color 0.12s ease;
    white-space: nowrap;
}
.se-btn:hover {
    background: #4f5866;
    color: #ffffff;
}
.se-btn-primary {
    background: #1a9fff;
    color: #ffffff;
    font-weight: 500;
}
.se-btn-primary:hover {
    background: #38aeff;
}
.se-muted {
    color: #8b929a;
    font-size: 11px;
    line-height: 1.4;
}
`;

let steamWebpackRequire = null;
function getWebpackRequire() {
    if (steamWebpackRequire) return steamWebpackRequire;
    if (window.webpackChunksteamui) {
        window.webpackChunksteamui.push([
            [Symbol("se_epic")],
            {},
            (r) => {
                steamWebpackRequire = r;
            },
        ]);
    }
    return steamWebpackRequire;
}

function getSteamPopupModules() {
    const req = getWebpackRequire();
    if (!req) return null;
    try {
        const React = req(63696);
        const ContextMenuMod = req(377);
        const MenuComponents = req(12711);
        if (React && ContextMenuMod?.lX && MenuComponents?.tz) {
            return {
                React,
                showContextMenu: ContextMenuMod.lX,
                MenuContainer: MenuComponents.tz,
            };
        }
    } catch (_) {}
    return null;
}

function openClaimPopup(url) {
    // Never call window.open() inside Steam's SharedJSContext because Steam intercepts
    // popup requests into its internal BrowserBackstack, which resets to data:text/html,<body></body>.
    // Instead, open a dedicated native WebKit2/pywebview checkout window via our backend daemon.
    callBackend("OpenClaimWindow", { url }).catch(() => {
        if (window.SteamClient?.System?.OpenInSystemBrowser) {
            window.SteamClient.System.OpenInSystemBrowser(url);
        }
    });
}

function healBlankSteamBrowser() {
    try {
        const mgr = window.MainWindowBrowserManager;
        if (!mgr || !mgr.m_browser) return;
        const cur = mgr.DisplayURL || mgr.m_URL || "";
        if (cur.startsWith("data:text/html") && mgr.m_history?.location?.pathname?.startsWith("/browser")) {
            const tab = mgr.GetLastActiveTab?.() || "store";
            mgr.ActivateTab?.(tab);
        }
    } catch (_) {}
}

function getStoredEpicAppIds() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_APPIDS);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

function findExistingEpicShortcuts() {
    const ids = new Set(getStoredEpicAppIds());
    try {
        const apps = window.appStore?.allApps || [];
        for (const app of apps) {
            if (!app) continue;
            const isShortcut =
                typeof app.BIsModOrShortcut === "function"
                    ? app.BIsModOrShortcut()
                    : app.app_type === 1073741824;
            if (!isShortcut) continue;
            const name = app.display_name || "";
            if (name.endsWith(" (Epic)")) {
                ids.add(app.appid);
            }
        }
    } catch (_) {}
    return Array.from(ids);
}

async function applyEpicShortcutsToSteam(enable, onProgressText) {
    if (!window.SteamClient?.Apps?.AddShortcut || !window.SteamClient?.Apps?.RemoveShortcut) {
        await callBackend("SyncSteamShortcuts");
        return;
    }

    if (!enable) {
        if (onProgressText) onProgressText("Odebírám Epic hry ze Steamu…");
        const toRemove = findExistingEpicShortcuts();
        for (const appid of toRemove) {
            try {
                window.SteamClient.Apps.RemoveShortcut(appid);
            } catch (_) {}
        }
        localStorage.setItem(STORAGE_KEY_APPIDS, "[]");
        localStorage.setItem(STORAGE_KEY_SYNC, "0");
        if (onProgressText) onProgressText("Zobrazit Epic hry ve Steam Knihovně");
        return;
    }

    if (onProgressText) onProgressText("Načítám hry z tvého Epicu…");
    const lib = await callBackend("GetEpicLibrary");
    if (!lib.authenticated) {
        if (onProgressText) onProgressText("Nejprve se přihlas k Epicu výše");
        return;
    }

    const oldIds = findExistingEpicShortcuts();
    for (const appid of oldIds) {
        try {
            window.SteamClient.Apps.RemoveShortcut(appid);
        } catch (_) {}
    }

    const helperPath = lib.helperPath || "/home/maty/Epic Steam/backend/epic_helper.py";
    const startDir = helperPath.substring(0, helperPath.lastIndexOf("/")) || "/usr/bin";
    const createdIds = [];

    for (const game of lib.games || []) {
        try {
            const displayName = `${game.title} (Epic)`;
            const args = `launch ${game.appName}`;
            const cmdline = `"${helperPath}" ${args}`;
            const appid = await window.SteamClient.Apps.AddShortcut(
                displayName,
                helperPath,
                args,
                cmdline
            );
            if (appid) {
                window.SteamClient.Apps.SetShortcutName?.(appid, displayName);
                window.SteamClient.Apps.SetShortcutExe?.(appid, `"${helperPath}"`);
                window.SteamClient.Apps.SetShortcutStartDir?.(appid, `"${startDir}"`);
                window.SteamClient.Apps.SetShortcutLaunchOptions?.(appid, args);
                createdIds.push(appid);
            }
        } catch (_) {}
    }

    localStorage.setItem(STORAGE_KEY_APPIDS, JSON.stringify(createdIds));
    localStorage.setItem(STORAGE_KEY_SYNC, "1");
    if (onProgressText) {
        onProgressText(`Epic hry v Knihovně (${createdIds.length} her)`);
    }
}

function createEpicPopupComponent(React, MenuContainer, initialFreeGames, onFreeDetected, closeMenuFn) {
    return function EpicMenuPopup() {
        const [loading, setLoading] = React.useState(true);
        const [auth, setAuth] = React.useState({ authenticated: false, displayName: null });
        const [freeGames, setFreeGames] = React.useState(initialFreeGames || []);
        const [syncOn, setSyncOn] = React.useState(localStorage.getItem(STORAGE_KEY_SYNC) === "1");
        const [syncText, setSyncText] = React.useState(() => {
            const isOn = localStorage.getItem(STORAGE_KEY_SYNC) === "1";
            return isOn
                ? `Epic hry v Knihovně (${getStoredEpicAppIds().length} her)`
                : "Zobrazit Epic hry ve Steam Knihovně";
        });
        const [loggingIn, setLoggingIn] = React.useState(false);

        React.useEffect(() => {
            let mounted = true;
            Promise.all([
                callBackend("GetAuthStatus"),
                initialFreeGames ? Promise.resolve({ ok: true, games: initialFreeGames }) : callBackend("GetFreeGames"),
            ])
                .then(([authRes, freeRes]) => {
                    if (!mounted) return;
                    setAuth(authRes || { authenticated: false });
                    if (freeRes?.games) {
                        setFreeGames(freeRes.games);
                        if (freeRes.games.length > 0 && onFreeDetected) onFreeDetected();
                    }
                    setLoading(false);
                })
                .catch(() => {
                    if (mounted) setLoading(false);
                });
            return () => {
                mounted = false;
            };
        }, []);

        React.useEffect(() => {
            if (!loggingIn) return;
            const timer = setInterval(async () => {
                try {
                    const st = await callBackend("GetAuthStatus");
                    if (st?.authenticated) {
                        clearInterval(timer);
                        setLoggingIn(false);
                        setAuth(st);
                        setSyncOn(true);
                        await applyEpicShortcutsToSteam(true, setSyncText);
                    }
                } catch (_) {}
            }, 2000);
            return () => clearInterval(timer);
        }, [loggingIn]);

        const handleLogin = async () => {
            setLoggingIn(true);
            await callBackend("AuthenticateEpic", { auth_code: "" });
        };

        const handleLogout = async () => {
            setSyncOn(false);
            await applyEpicShortcutsToSteam(false, setSyncText);
            await callBackend("AuthenticateEpic", { auth_code: "logout" });
            setAuth({ authenticated: false, displayName: null });
        };

        const handleToggleSync = async () => {
            const next = !syncOn;
            setSyncOn(next);
            await applyEpicShortcutsToSteam(next, setSyncText);
        };

        return React.createElement(
            MenuContainer,
            { bForceDesktopPresentation: true, style: { padding: 0, background: "#171d25" } },
            React.createElement("style", null, STEAM_POPUP_CSS),
            React.createElement(
                "div",
                { className: "se-popup-root" },
                React.createElement(
                    "div",
                    { className: "se-header-panel" },
                    !auth.authenticated
                        ? React.createElement(
                              "div",
                              { className: "se-account-row" },
                              React.createElement(
                                  "span",
                                  { className: "se-muted" },
                                  loggingIn ? "Dokonči přihlášení v okně…" : "Epic účet není připojen"
                              ),
                              React.createElement(
                                  "button",
                                  { className: "se-btn se-btn-primary", onClick: handleLogin },
                                  loggingIn ? "Čekám na login…" : "Přihlásit se k Epicu"
                              )
                          )
                        : React.createElement(
                              React.Fragment,
                              null,
                              React.createElement(
                                  "div",
                                  { className: "se-account-row" },
                                  React.createElement(
                                      "span",
                                      { style: { color: "#ffffff", fontWeight: 500 } },
                                      `Epic: ${auth.displayName}`
                                  ),
                                  React.createElement(
                                      "button",
                                      { className: "se-btn", onClick: handleLogout },
                                      "Odhlásit"
                                  )
                              ),
                              React.createElement(
                                  "div",
                                  { className: "se-toggle-row" },
                                  React.createElement("span", { style: { color: "#dcdedf" } }, syncText),
                                  React.createElement("div", {
                                      className: `se-switch ${syncOn ? "se-on" : ""}`,
                                      onClick: handleToggleSync,
                                  })
                              )
                          )
                ),
                React.createElement(
                    "div",
                    { className: "se-body" },
                    React.createElement("div", { className: "se-section-title" }, "Právě zdarma na Epicu"),
                    loading
                        ? React.createElement("div", { className: "se-muted" }, "Načítání…")
                        : freeGames.length === 0
                        ? React.createElement("div", { className: "se-muted" }, "Momentálně nejsou žádné free hry.")
                        : freeGames.map((g) =>
                              React.createElement(
                                  "div",
                                  { key: g.id || g.title, className: "se-card" },
                                  g.image
                                      ? React.createElement("img", { src: g.image, alt: g.title })
                                      : null,
                                  React.createElement(
                                      "div",
                                      { className: "se-card-info" },
                                      React.createElement("div", { className: "se-card-title" }, g.title),
                                      React.createElement(
                                          "button",
                                          {
                                              className: "se-btn se-btn-primary",
                                              onClick: () => {
                                                  if (closeMenuFn) closeMenuFn();
                                                  openClaimPopup(g.storeUrl);
                                              },
                                          },
                                          "Vyzvednout zdarma"
                                      )
                                  )
                              )
                          )
                )
            )
        );
    };
}

function placeButtonInSteamTopBar(doc, btn) {
    const titleBarControls =
        doc.querySelector("._1-9sir4j_KQiMqdkZjQN0u") ||
        doc.querySelector("._3cykd-VfN_xBxf3Qxriccm") ||
        doc.querySelector('[class*="TitleBarControls"]');
    if (titleBarControls) {
        if (btn.parentElement !== titleBarControls) {
            titleBarControls.insertBefore(btn, titleBarControls.firstChild);
        }
        return true;
    }
    return false;
}

function injectIntoWindow(win) {
    const doc = win.document;
    if (!doc || !doc.body) return;

    const existing = doc.querySelector(".se-top-btn");
    if (existing) {
        placeButtonInSteamTopBar(doc, existing);
        return;
    }

    if (!doc.getElementById("se-steam-styles")) {
        const style = doc.createElement("style");
        style.id = "se-steam-styles";
        style.textContent = STEAM_BUTTON_CSS;
        doc.head.appendChild(style);
    }

    const btn = doc.createElement("div");
    btn.className = "se-top-btn";
    btn.title = "Epic Free Games & Knihovna";
    const dot = doc.createElement("span");
    dot.className = "se-badge-dot";
    const label = doc.createElement("span");
    label.textContent = "Epic";
    btn.appendChild(dot);
    btn.appendChild(label);

    if (!placeButtonInSteamTopBar(doc, btn)) {
        return;
    }

    let cachedFreeGames = null;
    let activeMenuInstance = null;
    let lastHideTimestamp = 0;

    btn.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
    });

    btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        // If menu was open or just closed by blur on this mousedown, toggle off cleanly
        if (activeMenuInstance?.visible || Date.now() - lastHideTimestamp < 220) {
            if (activeMenuInstance?.visible) {
                activeMenuInstance.Hide();
            }
            activeMenuInstance = null;
            btn.classList.remove("se-active");
            return;
        }

        const mods = getSteamPopupModules();
        if (!mods) return;

        const { React, showContextMenu, MenuContainer } = mods;
        const EpicPopup = createEpicPopupComponent(
            React,
            MenuContainer,
            cachedFreeGames,
            () => dot.classList.add("se-visible"),
            () => {
                if (activeMenuInstance?.visible) activeMenuInstance.Hide();
            }
        );

        btn.classList.add("se-active");
        activeMenuInstance = showContextMenu(React.createElement(EpicPopup, null), btn, {
            bOverlapHorizontal: true,
            bForcePopup: true,
            bDisableMouseOverlay: true,
            title: "Epic Games Integration",
        });

        if (activeMenuInstance?.SetOnHideCallback) {
            activeMenuInstance.SetOnHideCallback(() => {
                lastHideTimestamp = Date.now();
                activeMenuInstance = null;
                btn.classList.remove("se-active");
            });
        }
    });

    callBackend("GetFreeGames")
        .then((res) => {
            if (res?.ok && Array.isArray(res.games)) {
                cachedFreeGames = res.games;
                if (res.games.length > 0) {
                    dot.classList.add("se-visible");
                }
            }
            const mods = getSteamPopupModules();
            const r = btn.getBoundingClientRect();
            callBackend("debug_set", {
                injected: true,
                parentClass: btn.parentElement?.className || "",
                btnRect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
                hasPopupModules: !!mods,
                freeCount: cachedFreeGames?.length || 0,
            }).catch(() => {});
        })
        .catch(() => {});
}

function initPlugin() {
    setInterval(() => {
        try {
            healBlankSteamBrowser();
            if (typeof g_PopupManager !== "undefined" && g_PopupManager.GetPopups) {
                Array.from(g_PopupManager.GetPopups()).forEach((p) => {
                    const w = p?.m_wnd || p?.window;
                    if (w?.document?.body && w.document.title !== "SharedJSContext") {
                        injectIntoWindow(w);
                    }
                });
            }
        } catch (_) {}
    }, 1200);
}

initPlugin();
