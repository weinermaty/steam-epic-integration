/**
 * Steam Epic Integration — Frontend
 * Subtle, native-Steam-styled integration for claiming Epic free games
 * and launching/syncing Epic library via Legendary without Epic Games Launcher.
 * Supports both Millennium IPC and direct localhost bridge (127.0.0.1:49812).
 */

const PLUGIN_NAME = "steam-epic-integration";
const LOCAL_DAEMON_URL = "http://127.0.0.1:49812";

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
        } catch (_) {
            // Fall through to local daemon bridge
        }
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
    margin: 0 4px;
    background: rgba(61, 68, 80, 0.55);
    color: #b8bcbf;
    border-radius: 2px;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    font-size: 12px;
    font-weight: 400;
    cursor: pointer;
    user-select: none;
    transition: background 0.12s ease, color 0.12s ease;
    -webkit-app-region: no-drag;
}
.se-top-btn:hover, .se-top-btn.se-active {
    background: #3d4450;
    color: #ffffff;
}
.se-badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #66c0f4;
    display: none;
}
.se-badge-dot.se-visible {
    display: inline-block;
}
.se-popover {
    position: fixed;
    top: 34px;
    right: 220px;
    width: 340px;
    max-height: 460px;
    background: #171d25;
    border: 1px solid #2a313c;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.75);
    color: #dcdedf;
    font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
    font-size: 12px;
    z-index: 99999;
    display: flex;
    flex-direction: column;
    border-radius: 2px;
}
.se-tabs {
    display: flex;
    background: #10151b;
    border-bottom: 1px solid #232933;
}
.se-tab {
    flex: 1;
    text-align: center;
    padding: 8px 0;
    color: #8b929a;
    cursor: pointer;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    border-bottom: 2px solid transparent;
}
.se-tab:hover {
    color: #dcdedf;
}
.se-tab.se-active {
    color: #ffffff;
    border-bottom-color: #1a9fff;
    background: rgba(26, 159, 255, 0.06);
}
.se-body {
    padding: 10px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.se-card {
    background: #23262e;
    border: 1px solid #2d333d;
    border-radius: 2px;
    overflow: hidden;
}
.se-card img {
    width: 100%;
    height: 110px;
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
}
.se-btn-primary:hover {
    background: #38aeff;
}
.se-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    background: #1e2329;
    border-radius: 2px;
}
.se-row-title {
    color: #dcdedf;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 205px;
}
.se-muted {
    color: #8b929a;
    font-size: 11px;
    line-height: 1.4;
}
.se-input {
    background: #10151b;
    border: 1px solid #2d333d;
    color: #ffffff;
    padding: 5px 8px;
    border-radius: 2px;
    font-size: 11px;
    width: 100%;
    box-sizing: border-box;
}
`;

function openInSteamBrowser(url) {
    if (window.SteamClient?.System?.OpenInSystemBrowser) {
        window.SteamClient.System.OpenInSystemBrowser(url);
    } else {
        window.open(url, "_blank", "width=980,height=720");
    }
}

function injectIntoWindow(win) {
    const doc = win.document;
    if (!doc || !doc.body || doc.querySelector(".se-top-btn")) return;

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
    let activeTab = "free";
    let cachedFree = null;

    async function renderTabContent(bodyEl) {
        bodyEl.innerHTML = '<div class="se-muted">Načítání…</div>';
        try {
            if (activeTab === "free") {
                const res = cachedFree || (await callBackend("GetFreeGames"));
                cachedFree = res;
                bodyEl.innerHTML = "";
                if (!res.ok || !res.games?.length) {
                    bodyEl.innerHTML = '<div class="se-muted">Momentálně nejsou žádné free hry.</div>';
                    return;
                }
                dot.classList.add("se-visible");
                res.games.forEach((g) => {
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
                    claimBtn.textContent = "Vyzvednout";
                    claimBtn.onclick = () => openInSteamBrowser(g.storeUrl);
                    info.appendChild(title);
                    info.appendChild(claimBtn);
                    card.appendChild(info);
                    bodyEl.appendChild(card);
                });
            } else {
                const res = await callBackend("GetEpicLibrary");
                bodyEl.innerHTML = "";
                if (!res.authenticated) {
                    const msg = doc.createElement("div");
                    msg.className = "se-muted";
                    msg.textContent = "Přihlas se jednou k Epic účtu (bez nutnosti instalovat Epic Launcher):";
                    const loginBtn = doc.createElement("button");
                    loginBtn.className = "se-btn se-btn-primary";
                    loginBtn.textContent = "1. Otevřít přihlášení a získat kód";
                    loginBtn.onclick = async () => {
                        const authRes = await callBackend("AuthenticateEpic", { auth_code: "" });
                        if (authRes.loginUrl) openInSteamBrowser(authRes.loginUrl);
                    };
                    const input = doc.createElement("input");
                    input.className = "se-input";
                    input.placeholder = "2. Vlož authorizationCode z prohlížeče…";
                    const confirmBtn = doc.createElement("button");
                    confirmBtn.className = "se-btn";
                    confirmBtn.textContent = "Potvrdit přihlášení";
                    confirmBtn.onclick = async () => {
                        if (!input.value.trim()) return;
                        confirmBtn.textContent = "Ověřování…";
                        await callBackend("AuthenticateEpic", { auth_code: input.value.trim() });
                        renderTabContent(bodyEl);
                    };
                    bodyEl.append(msg, loginBtn, input, confirmBtn);
                    return;
                }

                const headerRow = doc.createElement("div");
                headerRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;";
                const userSpan = doc.createElement("span");
                userSpan.className = "se-muted";
                userSpan.textContent = `Účet: ${res.displayName || "Přihlášen"}`;
                const syncBtn = doc.createElement("button");
                syncBtn.className = "se-btn";
                syncBtn.textContent = "Přidat vše do Steamu";
                syncBtn.onclick = async () => {
                    syncBtn.textContent = "Synchronizuji…";
                    const syncRes = await callBackend("SyncSteamShortcuts");
                    syncBtn.textContent = syncRes.ok ? `Hotovo (${syncRes.syncedCount})` : "Chyba";
                };
                headerRow.append(userSpan, syncBtn);
                bodyEl.appendChild(headerRow);

                if (!res.games?.length) {
                    const empty = doc.createElement("div");
                    empty.className = "se-muted";
                    empty.textContent = "V knihovně nejsou žádné hry.";
                    bodyEl.appendChild(empty);
                    return;
                }

                res.games.forEach((g) => {
                    const row = doc.createElement("div");
                    row.className = "se-row";
                    const t = doc.createElement("div");
                    t.className = "se-row-title";
                    t.textContent = g.title;
                    const act = doc.createElement("button");
                    act.className = g.installed ? "se-btn se-btn-primary" : "se-btn";
                    act.textContent = g.installed ? "Hrát" : "Instalovat";
                    act.onclick = async () => {
                        act.textContent = g.installed ? "Spouštím…" : "Stahuji…";
                        await callBackend("LaunchOrInstallEpicGame", { app_name: g.appName });
                    };
                    row.append(t, act);
                    bodyEl.appendChild(row);
                });
            }
        } catch (err) {
            bodyEl.innerHTML = `<div class="se-muted">Chyba: ${err.message || err}</div>`;
        }
    }

    function togglePopover() {
        if (popover) {
            popover.remove();
            popover = null;
            btn.classList.remove("se-active");
            return;
        }
        btn.classList.add("se-active");
        popover = doc.createElement("div");
        popover.className = "se-popover";

        const rect = btn.getBoundingClientRect();
        popover.style.top = `${Math.max(30, rect.bottom + 4)}px`;
        popover.style.right = `${Math.max(12, doc.documentElement.clientWidth - rect.right)}px`;

        const tabs = doc.createElement("div");
        tabs.className = "se-tabs";
        const tabFree = doc.createElement("div");
        tabFree.className = `se-tab ${activeTab === "free" ? "se-active" : ""}`;
        tabFree.textContent = "Zdarma";
        const tabLib = doc.createElement("div");
        tabLib.className = `se-tab ${activeTab === "lib" ? "se-active" : ""}`;
        tabLib.textContent = "Knihovna";

        const body = doc.createElement("div");
        body.className = "se-body";

        tabFree.onclick = () => {
            activeTab = "free";
            tabFree.className = "se-tab se-active";
            tabLib.className = "se-tab";
            renderTabContent(body);
        };
        tabLib.onclick = () => {
            activeTab = "lib";
            tabLib.className = "se-tab se-active";
            tabFree.className = "se-tab";
            renderTabContent(body);
        };

        tabs.append(tabFree, tabLib);
        popover.append(tabs, body);
        doc.body.appendChild(popover);
        renderTabContent(body);
    }

    btn.onclick = togglePopover;

    // Place right next to the top-right notification bell / megaphone buttons in Steam
    const targetBar =
        doc.querySelector('[class*="TitleBarControls"]') ||
        doc.querySelector('[class*="titlearea"]') ||
        doc.body;

    if (targetBar === doc.body) {
        btn.style.cssText = "position:fixed;top:6px;right:330px;z-index:99998;";
        doc.body.appendChild(btn);
    } else {
        targetBar.insertBefore(btn, targetBar.firstChild);
    }

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
