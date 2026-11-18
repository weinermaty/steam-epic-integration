/**
 * Steam Epic Integration — Frontend
 * Subtle, native-Steam-styled integration:
 * 1. Placed cleanly to the left of the blue megaphone button (never overlaps the user's nickname).
 * 2. 1-click Epic Games login window (automatically detects completion, no manual code copying).
 * 3. Instant toggle switch ("Zobrazit Epic hry ve Steam Knihovně") that adds/removes all Epic games
 *    live in Steam's sidebar via SteamClient.Apps.AddShortcut / RemoveShortcut without restarting Steam.
 * 4. Free games claimer with embedded checkout popup.
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

const STEAM_NATIVE_CSS = `
.se-top-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 10px;
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
.se-popover {
    position: fixed;
    width: 350px;
    max-height: 500px;
    background: #171d25;
    border: 1px solid #2a313c;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.85);
    color: #dcdedf;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    font-size: 12px;
    z-index: 99999;
    display: flex;
    flex-direction: column;
    border-radius: 3px;
    overflow: hidden;
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
}
.se-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #1b222c;
    padding: 7px 10px;
    border-radius: 2px;
    border: 1px solid #262f3d;
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
    margin-top: 2px;
}
.se-card {
    background: #23262e;
    border: 1px solid #2d333d;
    border-radius: 2px;
    overflow: hidden;
}
.se-card img {
    width: 100%;
    height: 120px;
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

function openClaimPopup(url) {
    // Open an in-Steam popup window where user stays logged in and can click "Get" + solve captcha
    const w = 1020;
    const h = 740;
    const left = Math.max(0, Math.round((window.screen.width - w) / 2));
    const top = Math.max(0, Math.round((window.screen.height - h) / 2));
    window.open(
        url,
        "EpicGamesStoreClaim",
        `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
    );
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

function findExistingEpicShortcuts(helperPath) {
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

async function applyEpicShortcutsToSteam(enable, statusLabelEl) {
    if (!window.SteamClient?.Apps?.AddShortcut || !window.SteamClient?.Apps?.RemoveShortcut) {
        await callBackend("SyncSteamShortcuts");
        return;
    }

    if (!enable) {
        if (statusLabelEl) statusLabelEl.textContent = "Odebírám Epic hry ze Steamu…";
        const toRemove = findExistingEpicShortcuts();
        for (const appid of toRemove) {
            try {
                window.SteamClient.Apps.RemoveShortcut(appid);
            } catch (_) {}
        }
        localStorage.setItem(STORAGE_KEY_APPIDS, "[]");
        localStorage.setItem(STORAGE_KEY_SYNC, "0");
        if (statusLabelEl) statusLabelEl.textContent = "Zobrazit Epic hry ve Steam Knihovně";
        return;
    }

    if (statusLabelEl) statusLabelEl.textContent = "Načítám hry z tvého Epicu…";
    const lib = await callBackend("GetEpicLibrary");
    if (!lib.authenticated) {
        if (statusLabelEl) statusLabelEl.textContent = "Nejprve se přihlas k Epicu výše";
        return;
    }

    // Remove previous Epic shortcuts first to avoid duplicates
    const oldIds = findExistingEpicShortcuts(lib.helperPath);
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
    if (statusLabelEl) {
        statusLabelEl.textContent = `Epic hry v Knihovně (${createdIds.length} her)`;
    }
}

function placeButtonInSteamTopBar(doc, btn) {
    // 1. Best: insert as the first flex item inside Steam's TitleBarControls container
    //    so flexbox automatically pushes the megaphone, bell, and nickname without overlapping!
    const titleBarControls =
        doc.querySelector("._1-9sir4j_KQiMqdkZjQN0u") ||
        doc.querySelector('[class*="TitleBarControls"]');
    if (titleBarControls) {
        btn.style.position = "relative";
        btn.style.top = "0";
        btn.style.right = "auto";
        btn.style.marginRight = "6px";
        if (btn.parentElement !== titleBarControls) {
            titleBarControls.insertBefore(btn, titleBarControls.firstChild);
        }
        return;
    }

    // 2. Fallback: insert right after "Help" in RootMenuBar (Steam | View | Friends | Games | Help | • Epic)
    const rootMenu =
        doc.querySelector("._3s0lkohH8wU2do0K1il28Y") ||
        doc.querySelector('[class*="RootMenuBar"]');
    if (rootMenu) {
        btn.style.position = "relative";
        btn.style.top = "0";
        btn.style.right = "auto";
        btn.style.marginLeft = "8px";
        if (btn.parentElement !== rootMenu) {
            rootMenu.appendChild(btn);
        }
        return;
    }
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
        style.textContent = STEAM_NATIVE_CSS;
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

    let popover = null;
    let cachedFree = null;
    let loginPollTimer = null;

    async function renderPopover(popEl) {
        popEl.innerHTML = '<div class="se-body"><div class="se-muted">Načítání…</div></div>';
        try {
            const [authRes, freeRes] = await Promise.all([
                callBackend("GetAuthStatus"),
                cachedFree ? Promise.resolve(cachedFree) : callBackend("GetFreeGames"),
            ]);
            cachedFree = freeRes;
            popEl.innerHTML = "";

            // 1. Header panel: Login state + 1-click Library Sync Toggle
            const header = doc.createElement("div");
            header.className = "se-header-panel";

            const accRow = doc.createElement("div");
            accRow.className = "se-account-row";

            if (!authRes.authenticated) {
                const info = doc.createElement("span");
                info.className = "se-muted";
                info.textContent = "Epic účet není připojen";
                const loginBtn = doc.createElement("button");
                loginBtn.className = "se-btn se-btn-primary";
                loginBtn.textContent = "Přihlásit se k Epicu";
                loginBtn.onclick = async () => {
                    loginBtn.textContent = "Otevírám přihlášení…";
                    await callBackend("AuthenticateEpic", { auth_code: "" });
                    if (loginPollTimer) clearInterval(loginPollTimer);
                    loginPollTimer = setInterval(async () => {
                        const st = await callBackend("GetAuthStatus");
                        if (st.authenticated) {
                            clearInterval(loginPollTimer);
                            loginPollTimer = null;
                            // Auto-enable library sync right after first login!
                            await applyEpicShortcutsToSteam(true, null);
                            if (popover) renderPopover(popover);
                        }
                    }, 2000);
                };
                accRow.append(info, loginBtn);
                header.appendChild(accRow);
            } else {
                const info = doc.createElement("span");
                info.style.cssText = "color:#ffffff;font-weight:500;";
                info.textContent = `Epic: ${authRes.displayName}`;
                const logoutBtn = doc.createElement("button");
                logoutBtn.className = "se-btn";
                logoutBtn.textContent = "Odhlásit";
                logoutBtn.onclick = async () => {
                    await applyEpicShortcutsToSteam(false, null);
                    await callBackend("AuthenticateEpic", { auth_code: "logout" });
                    if (popover) renderPopover(popover);
                };
                accRow.append(info, logoutBtn);

                // Toggle switch: Show Epic games in Steam Library
                const toggleRow = doc.createElement("div");
                toggleRow.className = "se-toggle-row";
                const isSyncOn = localStorage.getItem(STORAGE_KEY_SYNC) === "1";
                const toggleLabel = doc.createElement("span");
                toggleLabel.style.color = "#dcdedf";
                const count = getStoredEpicAppIds().length;
                toggleLabel.textContent = isSyncOn
                    ? `Epic hry v Knihovně (${count} her)`
                    : "Zobrazit Epic hry ve Steam Knihovně";

                const sw = doc.createElement("div");
                sw.className = `se-switch ${isSyncOn ? "se-on" : ""}`;
                sw.onclick = async () => {
                    const nextState = !sw.classList.contains("se-on");
                    sw.classList.toggle("se-on", nextState);
                    await applyEpicShortcutsToSteam(nextState, toggleLabel);
                };

                toggleRow.append(toggleLabel, sw);
                header.append(accRow, toggleRow);
            }

            popEl.appendChild(header);

            // 2. Body: Free games of the week
            const body = doc.createElement("div");
            body.className = "se-body";

            const secTitle = doc.createElement("div");
            secTitle.className = "se-section-title";
            secTitle.textContent = "Právě zdarma na Epicu";
            body.appendChild(secTitle);

            if (!freeRes.ok || !freeRes.games?.length) {
                const empty = doc.createElement("div");
                empty.className = "se-muted";
                empty.textContent = "Momentálně nejsou žádné free hry.";
                body.appendChild(empty);
            } else {
                dot.classList.add("se-visible");
                freeRes.games.forEach((g) => {
                    const card = doc.createElement("div");
                    card.className = "se-card";
                    if (g.image) {
                        const img = doc.createElement("img");
                        img.src = g.image;
                        card.appendChild(img);
                    }
                    const info = doc.createElement("div");
                    info.className = "se-card-info";
                    const title = doc.createElement("div");
                    title.className = "se-card-title";
                    title.textContent = g.title;
                    const claimBtn = doc.createElement("button");
                    claimBtn.className = "se-btn se-btn-primary";
                    claimBtn.textContent = "Vyzvednout zdarma";
                    claimBtn.onclick = () => openClaimPopup(g.storeUrl);
                    info.append(title, claimBtn);
                    card.appendChild(info);
                    body.appendChild(card);
                });
            }

            popEl.appendChild(body);
        } catch (err) {
            popEl.innerHTML = `<div class="se-body"><div class="se-muted">Chyba: ${err.message || err}</div></div>`;
        }
    }

    function togglePopover() {
        if (popover) {
            popover.remove();
            popover = null;
            btn.classList.remove("se-active");
            if (loginPollTimer) {
                clearInterval(loginPollTimer);
                loginPollTimer = null;
            }
            return;
        }
        btn.classList.add("se-active");
        popover = doc.createElement("div");
        popover.className = "se-popover";

        const rect = btn.getBoundingClientRect();
        popover.style.top = `${Math.max(32, rect.bottom + 6)}px`;
        popover.style.right = `${Math.max(12, doc.documentElement.clientWidth - rect.right)}px`;

        doc.body.appendChild(popover);
        renderPopover(popover);
    }

    btn.onclick = togglePopover;
    placeButtonInSteamTopBar(doc, btn);

    callBackend("GetFreeGames")
        .then((res) => {
            cachedFree = res;
            if (res?.ok && res.games?.length > 0) {
                dot.classList.add("se-visible");
            }
        })
        .catch(() => {});
}

function initPlugin() {
    setInterval(() => {
        try {
            if (typeof g_PopupManager !== "undefined" && g_PopupManager.GetPopups) {
                Array.from(g_PopupManager.GetPopups()).forEach((p) => {
                    const w = p?.m_wnd || p?.window;
                    if (w?.document?.body && w.document.title !== "SharedJSContext") {
                        injectIntoWindow(w);
                    }
                });
            }
        } catch (_) {}
    }, 1500);
}

initPlugin();
