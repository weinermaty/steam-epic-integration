/**
 * Steam Epic Integration — Frontend
 * 1. Pre-Created Hidden Popup (bCreateHidden: true, bRetainOnHide: true) — opens in 0 ms on click,
 *    matching Steam's native Notifications and Account menus.
 * 2. Throttled, smart diffing for 350+ Epic games — never freezes or crashes Steam, skips already-added
 *    games, and streams Epic cover artwork (capsule + hero) into Steam Library in the background.
 * 3. Direct 1-step authenticated Epic checkout modal — uses 32-char opaque EPIC_BEARER_TOKEN cookie
 *    in WebKit2 to open straight on `#/free-checkout` ("Add to library" / hCaptcha) without login prompts.
 * 4. Post-claim auto-sync — when a free game is claimed, it is automatically added to Steam Library.
 * 5. Native Steam Downloads page integration — injects Epic Games updates & active downloads directly
 *    into Steam's Downloads window (`._1bq4x9pa4-9RLY-dXWUZTp`).
 */

const PLUGIN_NAME = "steam-epic-integration";
const LOCAL_DAEMON_URL = "http://127.0.0.1:49812";
const STORAGE_KEY_SYNC = "se_epic_library_enabled";
const STORAGE_KEY_APPIDS = "se_epic_shortcut_appids";
const STORAGE_KEY_ART_DONE = "se_epic_artwork_applied_v4";
const STORAGE_KEY_SEEN_FREE = "se_seen_free_ids";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isCzechSteam() {
    try {
        const lang = new URLSearchParams(window.location?.search || "").get("LANGUAGE");
        if (lang) return lang.toLowerCase() === "czech";
        const loc = window.LocalizationManager?.GetPreferredLocales?.()?.[0];
        if (loc) return loc.toLowerCase().startsWith("cs");
    } catch (_) {}
    return false;
}

const tr = (cs, en) => (isCzechSteam() ? cs : en);

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
.se-top-btn.se-has-new {
    border-color: rgba(102, 192, 244, 0.7);
}
.se-badge-dot {
    display: none;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: #1a9fff;
    color: #ffffff;
    font-size: 10px;
    font-weight: 700;
    line-height: 14px;
    box-shadow: 0 0 8px rgba(26, 159, 255, 0.75);
    box-sizing: border-box;
}
.se-badge-dot.se-visible {
    display: inline-flex;
}
.se-dl-section {
    margin: 12px 24px;
    background: rgba(23, 29, 37, 0.75);
    border: 1px solid #2a313c;
    border-radius: 3px;
    padding: 12px 16px;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    color: #dcdedf;
}
.se-dl-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}
.se-dl-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: #66c0f4;
}
.se-dl-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #23262e;
    border: 1px solid #2d333d;
    padding: 8px 12px;
    border-radius: 2px;
    margin-top: 6px;
}
.se-dl-bar-wrap {
    width: 180px;
    height: 6px;
    background: #10151b;
    border-radius: 3px;
    overflow: hidden;
    margin: 0 12px;
}
.se-dl-bar {
    height: 100%;
    background: #1a9fff;
    transition: width 0.3s ease;
}
.se-epic-install-btn,
body[data-se-epic-uninstalled="1"] [class*="PlayButtonContainer"],
body[data-se-epic-uninstalled="1"] [class*="PlayButton"] {
    background: linear-gradient(90deg, #1a9fff 0%, #0066cc 100%) !important;
    box-shadow: 0 2px 8px rgba(26, 159, 255, 0.35) !important;
}
.se-epic-install-btn:hover,
body[data-se-epic-uninstalled="1"] [class*="PlayButtonContainer"]:hover,
body[data-se-epic-uninstalled="1"] [class*="PlayButton"]:hover {
    background: linear-gradient(90deg, #33adff 0%, #0077ee 100%) !important;
}
.se-epic-uninstalled-row,
.se-epic-uninstalled-row * {
    color: rgb(163, 170, 185) !important;
}
.se-epic-downloading-row,
.se-epic-downloading-row * {
    color: #66c0f4 !important;
}
.se-epic-row::after {
    content: attr(data-se-dl-pct);
    display: inline-flex;
    align-items: center;
    height: 14px;
    min-width: 14px;
    margin-left: auto;
    padding-left: 17px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M2.5 2.2C2.5 1.65 2.95 1.2 3.5 1.2H12.5C13.05 1.2 13.5 1.65 13.5 2.2V10.1C13.5 10.6 13.25 11.06 12.83 11.33L8.55 14.12C8.21 14.34 7.79 14.34 7.45 14.12L3.17 11.33C2.75 11.06 2.5 10.6 2.5 10.1V2.2Z' fill='%232b384c' stroke='%2366c0f4' stroke-width='1.15'/%3E%3Cpath d='M9.3 3.6L5.7 8.2H8.1L6.7 12.1L10.4 7.3H8L9.3 3.6Z' fill='%2366c0f4'/%3E%3C/svg%3E");
    background-position: left center;
    background-size: 13px 13px;
    background-repeat: no-repeat;
    font-size: 11px;
    font-weight: 700;
    color: #1a9fff !important;
    opacity: 0.9;
    flex-shrink: 0;
}
.se-epic-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 12px;
    padding: 4px 10px;
    border-radius: 3px;
    background: rgba(23, 29, 37, 0.85);
    border: 1px solid rgba(102, 192, 244, 0.35);
    color: #9ac6e8;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    vertical-align: middle;
    pointer-events: none;
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
        if (React && ContextMenuMod?.XX && MenuComponents?.tz) {
            return {
                React,
                contextMenuManager: ContextMenuMod.XX,
                showContextMenu: ContextMenuMod.lX,
                MenuContainer: MenuComponents.tz,
            };
        }
    } catch (_) {}
    return null;
}

let lastSeenClaimTs = 0;

function openClaimPopup(url) {
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

function getExistingEpicShortcutsMap() {
    const map = new Map();
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
                map.set(name, app.appid);
            }
        }
    } catch (_) {}
    return map;
}

let isSyncInProgress = false;
let artworkStreamGeneration = 0;

async function streamEpicCoverArtInBackground(gamesWithIds, onProgressText) {
    const myGen = ++artworkStreamGeneration;
    callBackend("CacheSteamGridArtwork", { items: gamesWithIds }).catch(() => {});

    if (!window.SteamClient?.Apps?.SetCustomArtworkForApp) return;

    let doneSet = {};
    try {
        doneSet = JSON.parse(localStorage.getItem(STORAGE_KEY_ART_DONE) || "{}");
    } catch (_) {
        doneSet = {};
    }

    const pending = gamesWithIds.filter((g) => {
        if (!(g.tallCover || g.wideCover)) return false;
        const ov = window.appStore?.GetAppOverviewByAppID?.(g.appid);
        return !doneSet[g.appid] || (ov && !ov.icon_data);
    });
    if (pending.length === 0) return;

    let doneCount = gamesWithIds.length - pending.length;
    for (const item of pending) {
        if (myGen !== artworkStreamGeneration) return;
        try {
            const res = await callBackend("GetArtworkBase64", {
                appName: item.appName,
                tallCover: item.tallCover || "",
                wideCover: item.wideCover || "",
            });
            if (res?.ok) {
                const ov = window.appStore?.GetAppOverviewByAppID?.(item.appid);
                if (res.iconBase64 && ov) {
                    ov.icon_data = res.iconBase64;
                    ov.icon_data_format = "png";
                }
                if (res.iconPath && window.SteamClient?.Apps?.SetShortcutIcon) {
                    try {
                        await window.SteamClient.Apps.SetShortcutIcon(item.appid, res.iconPath);
                    } catch (_) {}
                }
                if (!doneSet[item.appid]) {
                    if (res.tallBase64) {
                        await window.SteamClient.Apps.SetCustomArtworkForApp(item.appid, res.tallBase64, "jpg", 0);
                    }
                    if (res.wideBase64) {
                        await window.SteamClient.Apps.SetCustomArtworkForApp(item.appid, res.wideBase64, "jpg", 1);
                        await window.SteamClient.Apps.SetCustomArtworkForApp(item.appid, res.wideBase64, "jpg", 3);
                    }
                    doneSet[item.appid] = 1;
                }
                doneCount++;
                if (doneCount % 15 === 0) {
                    localStorage.setItem(STORAGE_KEY_ART_DONE, JSON.stringify(doneSet));
                    if (onProgressText) {
                        onProgressText(
                            tr(
                                `Epic v Knihovně (${gamesWithIds.length} her • obaly ${doneCount}/${gamesWithIds.length})`,
                                `Epic in Library (${gamesWithIds.length} games • art ${doneCount}/${gamesWithIds.length})`
                            )
                        );
                    }
                }
            }
        } catch (_) {}
        await sleep(12);
    }
    localStorage.setItem(STORAGE_KEY_ART_DONE, JSON.stringify(doneSet));
    if (onProgressText) {
        onProgressText(
            tr(
                `Epic hry v Knihovně (${gamesWithIds.length} her)`,
                `Epic games in Library (${gamesWithIds.length} games)`
            )
        );
    }
}

async function applyEpicShortcutsToSteam(enable, onProgressText, forceRefresh = false) {
    if (isSyncInProgress) return;
    isSyncInProgress = true;
    try {
        if (!window.SteamClient?.Apps?.AddShortcut || !window.SteamClient?.Apps?.RemoveShortcut) {
            await callBackend("SyncSteamShortcuts");
            return;
        }

        if (!enable) {
            artworkStreamGeneration++;
            const existingMap = getExistingEpicShortcutsMap();
            const toRemove = Array.from(existingMap.values());
            let idx = 0;
            for (const appid of toRemove) {
                try {
                    window.SteamClient.Apps.RemoveShortcut(appid);
                } catch (_) {}
                idx++;
                if (idx % 15 === 0) {
                    if (onProgressText) {
                        onProgressText(
                            tr(`Schovávám Epic hry (${idx}/${toRemove.length})…`, `Hiding Epic games (${idx}/${toRemove.length})…`)
                        );
                    }
                    await sleep(25);
                }
            }
            localStorage.setItem(STORAGE_KEY_APPIDS, "[]");
            localStorage.setItem(STORAGE_KEY_SYNC, "0");
            if (onProgressText) {
                onProgressText(tr("Zobrazit Epic hry ve Steam Knihovně", "Show Epic games in Steam Library"));
            }
            return;
        }

        if (onProgressText) onProgressText(tr("Načítám Epic knihovnu…", "Loading Epic library…"));
        const lib = await callBackend("GetEpicLibrary", { forceRefresh });
        if (!lib.authenticated) {
            if (onProgressText) onProgressText(tr("Nejprve se přihlas k Epicu výše", "Sign in to Epic above first"));
            return;
        }

        const existingMap = getExistingEpicShortcutsMap();
        const helperPath = lib.helperPath || "/home/maty/Epic Steam/backend/epic_helper.py";
        const startDir = helperPath.substring(0, helperPath.lastIndexOf("/")) || "/usr/bin";
        const allGames = lib.games || [];
        const finalIds = [];
        const artworkQueue = [];

        let processed = 0;
        for (const game of allGames) {
            const displayName = `${game.title} (Epic)`;
            let appid = existingMap.get(displayName);

            if (!appid) {
                try {
                    const args = `launch ${game.appName}`;
                    const cmdline = `"${helperPath}" ${args}`;
                    appid = await window.SteamClient.Apps.AddShortcut(
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
                    }
                    await sleep(18);
                } catch (_) {}
            }

            if (appid) {
                finalIds.push(appid);
                artworkQueue.push({
                    appid,
                    appName: game.appName,
                    tallCover: game.tallCover,
                    wideCover: game.wideCover,
                });
            }

            processed++;
            if (processed % 25 === 0 && onProgressText) {
                onProgressText(
                    tr(`Synchronizuji Epic (${processed}/${allGames.length})…`, `Syncing Epic (${processed}/${allGames.length})…`)
                );
            }
        }

        localStorage.setItem(STORAGE_KEY_APPIDS, JSON.stringify(finalIds));
        localStorage.setItem(STORAGE_KEY_SYNC, "1");
        if (onProgressText) {
            onProgressText(
                tr(
                    `Epic hry v Knihovně (${finalIds.length} her)`,
                    `Epic games in Library (${finalIds.length} games)`
                )
            );
        }

        streamEpicCoverArtInBackground(artworkQueue, onProgressText);
    } finally {
        isSyncInProgress = false;
    }
}

// Pre-fetched state so popup renders in 0ms on click
let preloadedState = {
    auth: { authenticated: false, displayName: null, lastClaimTs: 0 },
    freeGames: [],
    ready: false,
};
const stateSubscribers = new Set();

function notifyStateSubscribers() {
    for (const cb of stateSubscribers) {
        try {
            cb({ ...preloadedState });
        } catch (_) {}
    }
}

function getFreeGameIds(games) {
    return (games || []).map((g) => g.id || g.title).filter(Boolean);
}

function hasUnseenFreeGames(games) {
    const ids = getFreeGameIds(games);
    if (ids.length === 0) return false;
    try {
        const seen = JSON.parse(localStorage.getItem(STORAGE_KEY_SEEN_FREE) || "[]");
        const seenSet = new Set(Array.isArray(seen) ? seen : []);
        return ids.some((id) => !seenSet.has(id));
    } catch (_) {
        return true;
    }
}

function markFreeGamesSeen(games) {
    const ids = getFreeGameIds(games);
    if (ids.length === 0) return;
    try {
        localStorage.setItem(STORAGE_KEY_SEEN_FREE, JSON.stringify(ids));
    } catch (_) {}
}

function updateNewFreeBadge(badgeEl, btnEl, games) {
    if (!badgeEl) return;
    const unseen = hasUnseenFreeGames(games);
    badgeEl.classList.toggle("se-visible", unseen);
    if (btnEl) btnEl.classList.toggle("se-has-new", unseen);
}

async function refreshPreloadedState(badgeEl, forceFree = false, btnEl = null) {
    try {
        const [authRes, freeRes] = await Promise.all([
            callBackend("GetAuthStatus"),
            callBackend("GetFreeGames", { force: forceFree }),
        ]);
        preloadedState = {
            auth: authRes || { authenticated: false },
            freeGames: freeRes?.games || [],
            ready: true,
        };
        updateNewFreeBadge(badgeEl, btnEl, preloadedState.freeGames);
        notifyStateSubscribers();

        // Check if user just finished claiming a free game in the checkout window
        const claimTs = authRes?.lastClaimTs || 0;
        if (claimTs > lastSeenClaimTs && lastSeenClaimTs !== 0) {
            lastSeenClaimTs = claimTs;
            if (localStorage.getItem(STORAGE_KEY_SYNC) === "1" || getExistingEpicShortcutsMap().size > 0) {
                applyEpicShortcutsToSteam(true, null, true);
            }
        } else if (lastSeenClaimTs === 0 && claimTs > 0) {
            lastSeenClaimTs = claimTs;
        }
    } catch (_) {}
}

// Native Steam Downloads page integration: renders Epic updates & active transfers inside Steam's Downloads tab
let lastDownloadsCheckTs = 0;
let cachedUpdatesData = null;

async function injectEpicDownloadsSection(doc) {
    const downloadsPage =
        doc.querySelector("._1bq4x9pa4-9RLY-dXWUZTp") ||
        doc.querySelector('[class*="DownloadsPage"]');
    if (!downloadsPage) return;

    const now = Date.now();
    if (!cachedUpdatesData || now - lastDownloadsCheckTs > 4000) {
        lastDownloadsCheckTs = now;
        try {
            cachedUpdatesData = await callBackend("GetEpicUpdates", { checkRemote: false });
        } catch (_) {
            return;
        }
    }

    const pending = cachedUpdatesData?.pendingUpdates || [];
    const active = cachedUpdatesData?.activeTransfers || [];
    let container = downloadsPage.querySelector(".se-dl-section");

    if (pending.length === 0 && active.length === 0) {
        if (container) container.remove();
        return;
    }

    const renderKey = JSON.stringify({ pending, active });
    if (container && container.dataset.seRenderKey === renderKey) {
        return;
    }

    if (!container) {
        container = doc.createElement("div");
        container.className = "se-dl-section";
        const topBar = downloadsPage.querySelector("._373v1eWNyaPKhgnea9FZSt") || downloadsPage.firstChild;
        if (topBar && topBar.nextSibling) {
            downloadsPage.insertBefore(container, topBar.nextSibling);
        } else {
            downloadsPage.appendChild(container);
        }
    }

    container.dataset.seRenderKey = renderKey;
    container.innerHTML = "";
    const hdr = doc.createElement("div");
    hdr.className = "se-dl-header";
    const title = doc.createElement("div");
    title.className = "se-dl-title";
    title.textContent = tr(
        `Epic Games Aktualizace & Stahování (${pending.length + active.length})`,
        `Epic Games Updates & Downloads (${pending.length + active.length})`
    );
    const checkBtn = doc.createElement("button");
    checkBtn.className = "se-btn";
    checkBtn.textContent = tr("Zkontrolovat aktualizace", "Check for updates");
    checkBtn.onclick = async () => {
        checkBtn.textContent = tr("Kontroluji…", "Checking…");
        cachedUpdatesData = await callBackend("GetEpicUpdates", { checkRemote: true });
        injectEpicDownloadsSection(doc);
    };
    hdr.append(title, checkBtn);
    container.appendChild(hdr);

    for (const trItem of active) {
        const row = doc.createElement("div");
        row.className = "se-dl-row";
        const nameEl = doc.createElement("div");
        nameEl.style.cssText = "font-weight:500;color:#fff;flex:1;";
        nameEl.textContent = `${trItem.title} (Epic)`;
        const barWrap = doc.createElement("div");
        barWrap.className = "se-dl-bar-wrap";
        const bar = doc.createElement("div");
        bar.className = "se-dl-bar";
        bar.style.width = `${Math.min(100, Math.round(trItem.progress || 0))}%`;
        barWrap.appendChild(bar);
        const infoEl = doc.createElement("div");
        infoEl.className = "se-muted";
        infoEl.textContent =
            trItem.status === "completed"
                ? tr("Dokončeno (100%)", "Completed (100%)")
                : trItem.status === "failed"
                ? tr("Chyba stahování", "Download failed")
                : `${Math.round(trItem.progress || 0)}% ${trItem.speed ? "• " + trItem.speed : ""} ${trItem.eta ? "• ETA " + trItem.eta : ""}`;
        row.append(nameEl, barWrap, infoEl);
        container.appendChild(row);
    }

    for (const up of pending) {
        if (active.some((a) => a.appName === up.appName)) continue;
        const row = doc.createElement("div");
        row.className = "se-dl-row";
        const nameEl = doc.createElement("div");
        nameEl.style.cssText = "font-weight:500;color:#fff;";
        nameEl.textContent = tr(
            `${up.title} (Epic) — dostupná verze ${up.latestVersion}`,
            `${up.title} (Epic) — update available ${up.latestVersion}`
        );
        const updBtn = doc.createElement("button");
        updBtn.className = "se-btn se-btn-primary";
        updBtn.textContent = tr("Aktualizovat", "Update");
        updBtn.onclick = async () => {
            updBtn.textContent = tr("Spouštím…", "Starting…");
            await callBackend("UpdateEpicGame", { app_name: up.appName, title: up.title });
            lastDownloadsCheckTs = 0;
            injectEpicDownloadsSection(doc);
        };
        row.append(nameEl, updBtn);
        container.appendChild(row);
    }
}

const EPIC_PLUGIN_SVG = `<svg class="se-epic-badge-svg" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Epic"><path d="M2.5 2.2C2.5 1.65 2.95 1.2 3.5 1.2H12.5C13.05 1.2 13.5 1.65 13.5 2.2V10.1C13.5 10.6 13.25 11.06 12.83 11.33L8.55 14.12C8.21 14.34 7.79 14.34 7.45 14.12L3.17 11.33C2.75 11.06 2.5 10.6 2.5 10.1V2.2Z" fill="#2b384c" stroke="#66c0f4" stroke-width="1.15"/><path d="M9.3 3.6L5.7 8.2H8.1L6.7 12.1L10.4 7.3H8L9.3 3.6Z" fill="#66c0f4"/></svg>`;

function syncAppStoreEpicStates() {
    const apps = window.appStore?.allApps;
    if (!apps || !cachedUpdatesData) return;
    const installedTitles = new Set((cachedUpdatesData.installedGames || []).map((g) => g.title));
    const activeMap = new Map(
        (cachedUpdatesData.activeTransfers || [])
            .filter((t) => t.status === "downloading")
            .map((t) => [t.title, t])
    );

    for (const ov of apps) {
        if (!ov) continue;
        const name = ov.display_name || "";
        if (!name.endsWith(" (Epic)")) continue;
        const base = name.slice(0, -7);
        const isInst = installedTitles.has(base);
        const trItem = activeMap.get(base);
        const pcd = ov.per_client_data?.[0];
        if (!pcd) continue;

        const targetStatus = trItem ? 3 : 11;
        const targetPct = trItem ? Math.round(trItem.progress || 0) : isInst ? 100 : 0;
        if (pcd.installed !== isInst) pcd.installed = isInst;
        if (pcd.display_status !== targetStatus) pcd.display_status = targetStatus;
        if (pcd.status_percentage !== targetPct) pcd.status_percentage = targetPct;
    }
}

function refreshUpdatesCacheAsync(doc) {
    const now = Date.now();
    const hasActive = (cachedUpdatesData?.activeTransfers || []).some((t) => t.status === "downloading");
    const interval = hasActive ? 1500 : 4000;
    if (now - lastDownloadsCheckTs <= interval) return;
    lastDownloadsCheckTs = now;
    callBackend("GetEpicUpdates", { checkRemote: false })
        .then((res) => {
            if (res) {
                cachedUpdatesData = res;
                syncAppStoreEpicStates();
                if (doc) updateEpicGameDetailsStatus(doc);
            }
        })
        .catch(() => {});
}

function findRowLabelTextNode(doc, row) {
    const walker = doc.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
        if (node.parentElement?.closest?.(".se-epic-dl-pct, .se-epic-badge-svg")) continue;
        if (node.nodeValue && node.nodeValue.trim().length > 0) return node;
    }
    return null;
}

function syncSidebarEpicRows(doc) {
    if (!doc || doc.title !== "Steam") return;
    const installedTitles = new Set((cachedUpdatesData?.installedGames || []).map((g) => g.title));
    const activeMap = new Map(
        (cachedUpdatesData?.activeTransfers || [])
            .filter((t) => t.status === "downloading")
            .map((t) => [t.title, t])
    );

    const sidebarRows = doc.querySelectorAll('[class*="GameListEntryContainer"]');
    for (const row of sidebarRows) {
        const txtNode = findRowLabelTextNode(doc, row);
        const rawTxt = (txtNode?.nodeValue || "").trim();
        let base = "";

        if (rawTxt.endsWith(" (Epic)")) {
            base = rawTxt.slice(0, -7);
            row.dataset.seEpicBase = base;
            if (txtNode) txtNode.nodeValue = base;
        } else if (row.dataset.seEpicBase && rawTxt === row.dataset.seEpicBase) {
            base = row.dataset.seEpicBase;
        } else {
            if (row.dataset.seEpicBase) delete row.dataset.seEpicBase;
            if (row.dataset.seDlPct) delete row.dataset.seDlPct;
            row.classList.remove("se-epic-row", "se-epic-uninstalled-row", "se-epic-downloading-row");
            continue;
        }

        const isInst = installedTitles.has(base);
        const trItem = activeMap.get(base);

        row.classList.add("se-epic-row");
        row.classList.toggle("se-epic-downloading-row", !!trItem);
        row.classList.toggle("se-epic-uninstalled-row", !trItem && !isInst);

        if (trItem) {
            const pctText = `${Math.round(trItem.progress || 0)}%`;
            if (row.dataset.seDlPct !== pctText) row.dataset.seDlPct = pctText;
        } else if (row.dataset.seDlPct !== "") {
            row.dataset.seDlPct = "";
        }
    }
}

function updateEpicGameDetailsStatus(doc) {
    if (!doc || doc.title !== "Steam" || !doc.body) return;

    if (!doc.body.dataset.seObsAttached) {
        doc.body.dataset.seObsAttached = "1";
        try {
            let seMutating = false;
            const obs = new MutationObserver(() => {
                if (seMutating) return;
                seMutating = true;
                try {
                    updateEpicGameDetailsStatus(doc);
                } finally {
                    obs.takeRecords();
                    seMutating = false;
                }
            });
            obs.observe(doc.body, { childList: true, subtree: true, characterData: true });
            doc.addEventListener("scroll", () => syncSidebarEpicRows(doc), { capture: true, passive: true });
        } catch (_) {}
    }

    refreshUpdatesCacheAsync(doc);
    syncSidebarEpicRows(doc);

    const histPath = window.MainWindowBrowserManager?.m_history?.location?.pathname || "";
    const m = histPath.match(/\/library\/app\/(\d+)/);
    const selectedAppId = m ? Number(m[1]) : window.uiStore?.currentGameListSelection?.nAppId;
    if (!selectedAppId) {
        delete doc.body.dataset.seEpicUninstalled;
        return;
    }

    const ov = window.appStore?.GetAppOverviewByAppID?.(Number(selectedAppId));
    const displayName = ov?.display_name || "";
    const containers = Array.from(doc.querySelectorAll('[class*="PlayButtonContainer"]'));

    if (!displayName.endsWith(" (Epic)")) {
        delete doc.body.dataset.seEpicUninstalled;
        for (const container of containers) {
            if (container.dataset.seEpicInstallBtn === "1") {
                const playBtn = container.querySelector('[class*="PlayButton"]') || container;
                const btnTextEl = container.querySelector('[class*="ButtonText"]') || playBtn;
                if (btnTextEl && container.dataset.seOrigText) {
                    if (btnTextEl.firstChild?.nodeType === 3) {
                        btnTextEl.firstChild.nodeValue = container.dataset.seOrigText;
                    } else {
                        btnTextEl.textContent = container.dataset.seOrigText;
                    }
                }
                container.classList.remove("se-epic-install-btn");
                playBtn.classList.remove("se-epic-install-btn");
                delete container.dataset.seEpicInstallBtn;
            }
        }
        return;
    }

    const baseTitle = displayName.slice(0, -7);
    const installed = (cachedUpdatesData?.installedGames || []).some(
        (g) => g.title === baseTitle || `${g.title} (Epic)` === displayName
    );
    const activeTransfer = (cachedUpdatesData?.activeTransfers || []).find(
        (t) => (t.title === baseTitle || `${t.title} (Epic)` === displayName) && t.status === "downloading"
    );

    if (!installed || activeTransfer) {
        doc.body.dataset.seEpicUninstalled = "1";
    } else {
        delete doc.body.dataset.seEpicUninstalled;
    }

    if (containers.length === 0) return;

    for (const container of containers) {
        const playBtn = container.querySelector('[class*="PlayButton"]') || container;
        const btnTextEl = container.querySelector('[class*="ButtonText"]') || playBtn;

        if (!installed || activeTransfer) {
            const targetLabel = activeTransfer
                ? tr(
                      `Stahuje se ${Math.round(activeTransfer.progress || 0)}%`,
                      `Downloading ${Math.round(activeTransfer.progress || 0)}%`
                  )
                : tr("Nainstalovat", "Install");
            if (btnTextEl) {
                if (!container.dataset.seOrigText) {
                    container.dataset.seOrigText = btnTextEl.textContent || "Play";
                }
                if (btnTextEl.textContent.trim() !== targetLabel) {
                    if (btnTextEl.firstChild?.nodeType === 3) {
                        btnTextEl.firstChild.nodeValue = targetLabel;
                    } else {
                        btnTextEl.textContent = targetLabel;
                    }
                }
            }
            container.classList.add("se-epic-install-btn");
            playBtn.classList.add("se-epic-install-btn");
            container.dataset.seEpicInstallBtn = "1";
        } else if (container.dataset.seEpicInstallBtn === "1") {
            if (btnTextEl && container.dataset.seOrigText) {
                if (btnTextEl.firstChild?.nodeType === 3) {
                    btnTextEl.firstChild.nodeValue = container.dataset.seOrigText;
                } else {
                    btnTextEl.textContent = container.dataset.seOrigText;
                }
            }
            container.classList.remove("se-epic-install-btn");
            playBtn.classList.remove("se-epic-install-btn");
            delete container.dataset.seEpicInstallBtn;
        }
    }
}

function createEpicPopupComponent(React, MenuContainer, getCloseFn) {
    return function EpicMenuPopup() {
        const [snap, setSnap] = React.useState(preloadedState);
        const [syncOn, setSyncOn] = React.useState(localStorage.getItem(STORAGE_KEY_SYNC) === "1");
        const [syncText, setSyncText] = React.useState(() => {
            const existingCount = getExistingEpicShortcutsMap().size;
            const isOn = localStorage.getItem(STORAGE_KEY_SYNC) === "1" || existingCount > 0;
            return isOn
                ? tr(`Epic hry v Knihovně (${existingCount} her)`, `Epic games in Library (${existingCount} games)`)
                : tr("Zobrazit Epic hry ve Steam Knihovně", "Show Epic games in Steam Library");
        });
        const [loggingIn, setLoggingIn] = React.useState(false);

        React.useEffect(() => {
            const sub = (nextSnap) => setSnap(nextSnap);
            stateSubscribers.add(sub);
            if (!preloadedState.ready) {
                refreshPreloadedState(null);
            }
            return () => stateSubscribers.delete(sub);
        }, []);

        React.useEffect(() => {
            if (!loggingIn) return;
            const timer = setInterval(async () => {
                try {
                    const st = await callBackend("GetAuthStatus");
                    if (st?.authenticated) {
                        clearInterval(timer);
                        setLoggingIn(false);
                        preloadedState.auth = st;
                        notifyStateSubscribers();
                        setSyncOn(true);
                        await applyEpicShortcutsToSteam(true, setSyncText, true);
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
            preloadedState.auth = { authenticated: false, displayName: null };
            notifyStateSubscribers();
        };

        const handleToggleSync = async () => {
            if (isSyncInProgress) return;
            const next = !syncOn;
            setSyncOn(next);
            await applyEpicShortcutsToSteam(next, setSyncText);
        };

        const auth = snap.auth;
        const freeGames = snap.freeGames;

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
                                  loggingIn
                                      ? tr("Dokonči přihlášení v okně…", "Complete sign-in in the popup…")
                                      : tr("Epic účet není připojen", "Epic account not connected")
                              ),
                              React.createElement(
                                  "button",
                                  { className: "se-btn se-btn-primary", onClick: handleLogin },
                                  loggingIn
                                      ? tr("Čekám na login…", "Waiting for login…")
                                      : tr("Přihlásit se k Epicu", "Sign in to Epic")
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
                                      tr("Odhlásit", "Sign out")
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
                    React.createElement("div", { className: "se-section-title" }, tr("Právě zdarma na Epicu", "Free on Epic right now")),
                    !snap.ready && freeGames.length === 0
                        ? React.createElement("div", { className: "se-muted" }, tr("Načítání…", "Loading…"))
                        : freeGames.length === 0
                        ? React.createElement("div", { className: "se-muted" }, tr("Momentálně nejsou žádné free hry.", "No free games right now."))
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
                                                  const closeFn = getCloseFn();
                                                  if (closeFn) closeFn();
                                                  openClaimPopup(g.checkoutUrl || g.storeUrl);
                                              },
                                          },
                                          tr("Vyzvednout zdarma", "Claim for free")
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

    injectEpicDownloadsSection(doc);
    updateEpicGameDetailsStatus(doc);

    let style = doc.getElementById("se-steam-styles");
    if (!style) {
        style = doc.createElement("style");
        style.id = "se-steam-styles";
        style.textContent = STEAM_BUTTON_CSS;
        doc.head.appendChild(style);
    } else if (style.textContent !== STEAM_BUTTON_CSS) {
        style.textContent = STEAM_BUTTON_CSS;
    }

    const existing = doc.querySelector(".se-top-btn");
    if (existing) {
        placeButtonInSteamTopBar(doc, existing);
        return;
    }

    const btn = doc.createElement("div");
    btn.className = "se-top-btn";
    btn.title = tr("Epic Free Games & Knihovna", "Epic Free Games & Library");
    const dot = doc.createElement("span");
    dot.className = "se-badge-dot";
    dot.textContent = "!";
    const label = doc.createElement("span");
    label.textContent = "Epic";
    btn.appendChild(dot);
    btn.appendChild(label);

    if (!placeButtonInSteamTopBar(doc, btn)) {
        return;
    }

    let retainedMenuInstance = null;
    let lastHideTimestamp = 0;

    function ensurePrewarmedPopup() {
        if (retainedMenuInstance) return retainedMenuInstance;
        const mods = getSteamPopupModules();
        if (!mods) return null;

        const { React, contextMenuManager, MenuContainer } = mods;
        const mgr = contextMenuManager.GetContextMenuManagerFromWindow(btn);
        if (!mgr || !mgr.CreateContextMenuInstance) return null;

        const EpicPopup = createEpicPopupComponent(React, MenuContainer, () => () => {
            if (retainedMenuInstance?.visible) retainedMenuInstance.Hide();
        });

        retainedMenuInstance = mgr.CreateContextMenuInstance(
            React.createElement(EpicPopup, null),
            btn,
            undefined,
            undefined,
            {
                bOverlapHorizontal: true,
                bForcePopup: true,
                bDisableMouseOverlay: true,
                bCreateHidden: true,
                bRetainOnHide: true,
                title: "Epic Games Integration",
            }
        );

        if (retainedMenuInstance?.SetOnHideCallback) {
            retainedMenuInstance.SetOnHideCallback(() => {
                lastHideTimestamp = Date.now();
                btn.classList.remove("se-active");
            });
        }
        return retainedMenuInstance;
    }

    setTimeout(() => {
        ensurePrewarmedPopup();
    }, 600);

    // Poll every 4 seconds for completed free-game claims and weekly free-game rotation
    setInterval(() => {
        refreshPreloadedState(dot, false, btn);
    }, 4000);

    btn.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
    });

    btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const inst = ensurePrewarmedPopup();
        if (!inst) return;

        if (inst.visible || Date.now() - lastHideTimestamp < 220) {
            if (inst.visible) inst.Hide();
            btn.classList.remove("se-active");
            return;
        }

        // Player opened the menu and checked the current free games -> clear the "!" alert
        markFreeGamesSeen(preloadedState.freeGames);
        updateNewFreeBadge(dot, btn, preloadedState.freeGames);

        btn.classList.add("se-active");
        inst.Show();
        refreshPreloadedState(dot, false, btn);
    });

    refreshPreloadedState(dot, false, btn).then(() => {
        const existingCount = getExistingEpicShortcutsMap().size;
        if (existingCount > 0) {
            localStorage.setItem(STORAGE_KEY_SYNC, "1");
            applyEpicShortcutsToSteam(true, null, false);
        }
        const mods = getSteamPopupModules();
        const r = btn.getBoundingClientRect();
        callBackend("debug_set", {
            injected: true,
            parentClass: btn.parentElement?.className || "",
            btnRect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
            hasPopupModules: !!mods,
            prewarmedPopup: !!retainedMenuInstance,
            existingEpicShortcuts: existingCount,
            freeCount: preloadedState.freeGames.length,
        }).catch(() => {});
    });
}

function initPlugin() {
    if (window.__SE_EPIC_VERSION === 14) return;
    window.__SE_EPIC_VERSION = 14;
    if (window.__SE_EPIC_TIMER) {
        clearInterval(window.__SE_EPIC_TIMER);
    }
    try {
        Array.from(g_PopupManager?.GetPopups?.() || []).forEach((p) => {
            const d = (p?.m_wnd || p?.window)?.document;
            if (d?.body?.dataset?.seObsAttached) delete d.body.dataset.seObsAttached;
        });
    } catch (_) {}

    refreshUpdatesCacheAsync(null);

    const tick = () => {
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
    };

    try {
        window.MainWindowBrowserManager?.m_history?.listen?.(() => {
            tick();
            Promise.resolve().then(tick);
        });
    } catch (_) {}

    tick();
    window.__SE_EPIC_TIMER = setInterval(tick, 350);
}

initPlugin();
