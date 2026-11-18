#!/usr/bin/env python3
"""
Backend helper & local daemon for steam-epic-integration.
Handles:
1. Fetching active Epic Games Store free games promotions (with offerId & namespace for direct 1-step checkout).
2. Reading Epic Games library & auth status instantly from cached ~/.config/legendary/metadata/*.json (including tall/wide cover artwork URLs).
3. Seamless 1-click Epic Games login via native WebKit2/pywebview window.
4. Direct 1-step free game claim window: automatically exchanges Legendary OAuth token for a web session inside WebKit2 and redirects straight to the Epic checkout modal (`https://www.epicgames.com/store/purchase?...`), skipping store navigation and re-login so the user only confirms the order / captcha.
5. Background Steam artwork downloader: caches Epic cover images into ~/.steam/steam/userdata/*/config/grid/<appid>p.jpg & <appid>_hero.jpg + returns base64 thumbnails on demand.
"""

import base64
import binascii
import concurrent.futures
import glob
import http.server
import json
import os
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

EPIC_FREE_GAMES_URL = (
    "https://store-site-backend-static.ak.epicgames.com/"
    "freeGamesPromotions?locale=en-US&country=CZ&allowCountries=CZ"
)
DAEMON_PORT = 49812
STEAMUI_INDEX = os.path.expanduser("~/.steam/steam/steamui/index.html")
STEAMUI_SCRIPT = os.path.expanduser("~/.steam/steam/steamui/epic-integration.js")
FRONTEND_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "frontend",
    "index.js",
)
ARTWORK_CACHE_DIR = os.path.expanduser("~/.cache/steam-epic-integration/artwork")

LAST_DEBUG_REPORT = {}
_CACHED_FREE = {"ts": 0.0, "data": None}


def find_legendary() -> str:
    path = shutil.which("legendary")
    if path:
        return path
    local_bin = os.path.expanduser("~/.local/bin/legendary")
    if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
        return local_bin
    return "legendary"


def get_free_games() -> dict:
    now = time.time()
    if _CACHED_FREE["data"] and now - _CACHED_FREE["ts"] < 300:
        return _CACHED_FREE["data"]
    try:
        req = urllib.request.Request(
            EPIC_FREE_GAMES_URL,
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) SteamClient"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read().decode("utf-8"))

        elements = (
            raw.get("data", {})
            .get("Catalog", {})
            .get("searchStore", {})
            .get("elements", [])
        )
        games = []
        for el in elements:
            promos = el.get("promotions")
            if not promos:
                continue
            active_offers = promos.get("promotionalOffers", [])
            if not active_offers or not active_offers[0].get("promotionalOffers"):
                continue

            offer = active_offers[0]["promotionalOffers"][0]
            discount = offer.get("discountSetting", {}).get("discountPercentage", 100)
            price_info = el.get("price", {}).get("totalPrice", {})
            if discount != 0 and price_info.get("discountPrice", -1) != 0:
                continue

            slug = el.get("productSlug") or el.get("urlSlug") or ""
            mappings = el.get("catalogNs", {}).get("mappings", [])
            if mappings and mappings[0].get("pageSlug"):
                slug = mappings[0]["pageSlug"]
            slug = slug.split("/")[0]

            img_url = ""
            for img in el.get("keyImages", []):
                if img.get("type") in (
                    "OfferImageWide",
                    "DieselStoreFrontWide",
                    "Thumbnail",
                ):
                    img_url = img.get("url", "")
                    break
            if not img_url and el.get("keyImages"):
                img_url = el["keyImages"][0].get("url", "")

            offer_id = el.get("id", "")
            namespace = el.get("namespace", "")
            store_url = (
                f"https://store.epicgames.com/en-US/p/{slug}"
                if slug
                else "https://store.epicgames.com/en-US/free-games"
            )
            checkout_url = (
                f"https://www.epicgames.com/store/purchase?highlightColor=0078f2"
                f"&offers=1-{namespace}-{offer_id}&orderId&purchaseToken&showNavigation=true"
                if offer_id and namespace
                else store_url
            )
            games.append(
                {
                    "id": offer_id,
                    "namespace": namespace,
                    "title": el.get("title", "Unknown Game"),
                    "description": el.get("description", ""),
                    "image": img_url,
                    "endDate": offer.get("endDate", ""),
                    "storeUrl": store_url,
                    "checkoutUrl": checkout_url,
                }
            )
        res = {"ok": True, "games": games}
        _CACHED_FREE["ts"] = now
        _CACHED_FREE["data"] = res
        return res
    except Exception as exc:
        return {"ok": False, "error": str(exc), "games": []}


def get_auth_status() -> dict:
    user_json = os.path.expanduser("~/.config/legendary/user.json")
    if os.path.isfile(user_json):
        try:
            with open(user_json, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {
                "authenticated": True,
                "displayName": data.get("displayName", "Epic User"),
            }
        except Exception:
            pass
    return {"authenticated": False, "displayName": None}


def get_epic_library() -> dict:
    auth = get_auth_status()
    helper_path = os.path.abspath(__file__)
    if not auth["authenticated"]:
        return {
            "ok": True,
            "authenticated": False,
            "helperPath": helper_path,
            "games": [],
        }

    installed_map = {}
    installed_json = os.path.expanduser("~/.config/legendary/installed.json")
    if os.path.isfile(installed_json):
        try:
            with open(installed_json, "r", encoding="utf-8") as f:
                installed_map = json.load(f)
        except Exception:
            installed_map = {}

    meta_dir = os.path.expanduser("~/.config/legendary/metadata")
    meta_files = glob.glob(os.path.join(meta_dir, "*.json"))

    # If metadata directory is empty on first run, populate it once via legendary list
    if not meta_files:
        try:
            subprocess.run(
                [find_legendary(), "list", "--json"],
                capture_output=True,
                text=True,
                timeout=25,
            )
            meta_files = glob.glob(os.path.join(meta_dir, "*.json"))
        except Exception:
            pass

    games = []
    for mf in meta_files:
        try:
            with open(mf, "r", encoding="utf-8") as f:
                item = json.load(f)
            meta = item.get("metadata", {})
            # Skip DLCs / non-game items without asset_infos
            if meta.get("mainGameItem") or not item.get("asset_infos"):
                continue
            app_name = item.get("app_name", "")
            title = item.get("app_title") or meta.get("title") or app_name
            if not app_name or not title:
                continue

            pics = {
                p.get("type"): p.get("url")
                for p in meta.get("keyImages", [])
                if p.get("type") and p.get("url")
            }
            tall_url = (
                pics.get("DieselGameBoxTall")
                or pics.get("OfferImageTall")
                or pics.get("Thumbnail")
                or ""
            )
            wide_url = (
                pics.get("DieselGameBox")
                or pics.get("OfferImageWide")
                or pics.get("DieselStoreFrontWide")
                or tall_url
            )
            games.append(
                {
                    "appName": app_name,
                    "title": title,
                    "installed": app_name in installed_map,
                    "installPath": installed_map.get(app_name, {}).get(
                        "install_path", ""
                    ),
                    "tallCover": tall_url,
                    "wideCover": wide_url,
                }
            )
        except Exception:
            continue

    games.sort(key=lambda g: (not g["installed"], g["title"].lower()))
    return {
        "ok": True,
        "authenticated": True,
        "displayName": auth["displayName"],
        "helperPath": helper_path,
        "games": games,
    }


def _download_artwork_bytes(app_name: str, kind: str, url: str) -> bytes:
    if not url:
        return b""
    os.makedirs(ARTWORK_CACHE_DIR, exist_ok=True)
    safe_id = "".join(c for c in app_name if c.isalnum() or c in "-_")
    cache_file = os.path.join(ARTWORK_CACHE_DIR, f"{safe_id}_{kind}.jpg")
    if os.path.isfile(cache_file) and os.path.getsize(cache_file) > 256:
        try:
            with open(cache_file, "rb") as f:
                return f.read()
        except Exception:
            pass

    sep = "&" if "?" in url else "?"
    sized_url = f"{url}{sep}h=600&w=400&resize=1" if kind == "tall" else f"{url}{sep}h=430&w=920&resize=1"
    try:
        req = urllib.request.Request(
            sized_url,
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) SteamClient"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read()
        if len(data) > 256:
            with open(cache_file, "wb") as f:
                f.write(data)
            return data
    except Exception:
        pass
    return b""


def cache_steam_grid_artwork(items: list) -> dict:
    """
    Given a list of {"appid": int, "appName": str, "tallCover": str, "wideCover": str},
    downloads images in parallel and writes them to ~/.steam/steam/userdata/*/config/grid/
    (<appid>p.jpg, <appid>.jpg, <appid>_hero.jpg).
    """
    grid_dirs = []
    for cfg in glob.glob(os.path.expanduser("~/.steam/steam/userdata/*/config")):
        gdir = os.path.join(cfg, "grid")
        os.makedirs(gdir, exist_ok=True)
        grid_dirs.append(gdir)

    def _process_one(entry):
        appid = entry.get("appid")
        app_name = entry.get("appName", "")
        if not appid or not app_name:
            return False
        tall_bytes = _download_artwork_bytes(app_name, "tall", entry.get("tallCover", ""))
        wide_bytes = _download_artwork_bytes(app_name, "wide", entry.get("wideCover", ""))
        for gdir in grid_dirs:
            if tall_bytes:
                for suffix in ("p.jpg", "p.png"):
                    p = os.path.join(gdir, f"{appid}{suffix}")
                    if not os.path.isfile(p):
                        with open(p, "wb") as f:
                            f.write(tall_bytes)
            if wide_bytes:
                for suffix in (".jpg", "_hero.jpg"):
                    p = os.path.join(gdir, f"{appid}{suffix}")
                    if not os.path.isfile(p):
                        with open(p, "wb") as f:
                            f.write(wide_bytes)
        return True

    threading.Thread(
        target=lambda: list(
            concurrent.futures.ThreadPoolExecutor(max_workers=8).map(_process_one, items)
        ),
        daemon=True,
    ).start()
    return {"ok": True, "queued": len(items)}


def get_artwork_base64(app_name: str, kind: str, url: str) -> dict:
    data = _download_artwork_bytes(app_name, kind, url)
    if not data:
        return {"ok": False}
    return {"ok": True, "base64": base64.b64encode(data).decode("ascii")}


def _vdf_str(key: str, val: str) -> bytes:
    return b"\x01" + key.encode("utf-8") + b"\x00" + val.encode("utf-8") + b"\x00"


def _vdf_int(key: str, val: int) -> bytes:
    return b"\x02" + key.encode("utf-8") + b"\x00" + struct.pack("<I", val & 0xFFFFFFFF)


def _compute_shortcut_appid(exe: str, appname: str) -> int:
    crc = binascii.crc32((exe + appname).encode("utf-8")) & 0xFFFFFFFF
    return (crc | 0x80000000) & 0xFFFFFFFF


def build_shortcuts_vdf(entries: list) -> bytes:
    out = bytearray(b"\x00shortcuts\x00")
    for idx, entry in enumerate(entries):
        out += b"\x00" + str(idx).encode("utf-8") + b"\x00"
        appid = entry.get("appid") or _compute_shortcut_appid(
            entry["Exe"], entry["AppName"]
        )
        out += _vdf_int("appid", appid)
        out += _vdf_str("AppName", entry["AppName"])
        out += _vdf_str("Exe", entry["Exe"])
        out += _vdf_str("StartDir", entry.get("StartDir", '"/usr/bin"'))
        out += _vdf_str("icon", entry.get("icon", ""))
        out += _vdf_str("ShortcutPath", "")
        out += _vdf_str("LaunchOptions", entry.get("LaunchOptions", ""))
        out += _vdf_int("IsHidden", 0)
        out += _vdf_int("AllowDesktopConfig", 1)
        out += _vdf_int("AllowOverlay", 1)
        out += _vdf_int("OpenVR", 0)
        out += _vdf_int("Devkit", 0)
        out += _vdf_str("DevkitGameID", "")
        out += _vdf_int("DevkitOverrideAppID", 0)
        out += _vdf_int("LastPlayTime", 0)
        out += _vdf_str("FlatpakAppID", "")
        out += b"\x00tags\x00"
        out += _vdf_str("0", "Epic Games")
        out += b"\x08"
        out += b"\x08"
    out += b"\x08\x08"
    return bytes(out)


def sync_to_steam_shortcuts() -> dict:
    lib = get_epic_library()
    if not lib.get("authenticated"):
        return {"ok": False, "error": "Nejprve se přihlas k Epic účtu."}

    helper_path = os.path.abspath(__file__)
    games = lib.get("games", [])
    entries = []
    for g in games:
        entries.append(
            {
                "AppName": f"{g['title']} (Epic)",
                "Exe": f'"{helper_path}"',
                "StartDir": f'"{os.path.dirname(helper_path)}"',
                "LaunchOptions": f'launch {g["appName"]}',
            }
        )

    vdf_bytes = build_shortcuts_vdf(entries)
    userdata_pattern = os.path.expanduser("~/.steam/steam/userdata/*/config")
    configs = glob.glob(userdata_pattern)
    written = []
    for cfg_dir in configs:
        vdf_path = os.path.join(cfg_dir, "shortcuts.vdf")
        with open(vdf_path, "wb") as f:
            f.write(vdf_bytes)
        written.append(vdf_path)

    return {"ok": True, "syncedCount": len(entries), "paths": written}


def launch_or_install_game(app_name: str) -> dict:
    if not app_name or not all(c.isalnum() or c in "-_." for c in app_name):
        return {"ok": False, "error": "Invalid app_name"}

    leg = find_legendary()
    installed_json = os.path.expanduser("~/.config/legendary/installed.json")
    is_installed = False
    if os.path.isfile(installed_json):
        try:
            with open(installed_json, "r", encoding="utf-8") as f:
                is_installed = app_name in json.load(f)
        except Exception:
            pass

    if is_installed:
        subprocess.Popen(
            [leg, "launch", app_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return {"ok": True, "action": "launched", "appName": app_name}
    else:
        cmd = f'"{leg}" install -y "{app_name}" && "{leg}" launch "{app_name}"'
        subprocess.Popen(
            ["/bin/sh", "-c", cmd],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return {"ok": True, "action": "installing", "appName": app_name}


def start_auth(code: str = "") -> dict:
    leg = find_legendary()
    if code == "logout":
        subprocess.run([leg, "auth", "--delete"], capture_output=True, timeout=10)
        return {"ok": True, "authenticated": False}

    if not code:
        env = os.environ.copy()
        env.setdefault("DISPLAY", ":0")
        subprocess.Popen(
            [leg, "auth"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return {"ok": True, "startedWebview": True}

    try:
        proc = subprocess.run(
            [leg, "auth", "--code", code.strip()],
            capture_output=True,
            text=True,
            timeout=20,
        )
        status = get_auth_status()
        if status["authenticated"]:
            return {
                "ok": True,
                "authenticated": True,
                "displayName": status["displayName"],
            }
        return {
            "ok": False,
            "authenticated": False,
            "error": (proc.stderr or proc.stdout or "Auth failed").strip(),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def open_claim_window(target_url: str) -> dict:
    """
    Opens a compact checkout window pre-authenticated with the user's Legendary session!
    1. Generates a fresh 1-time exchangeCode from LegendaryCore in the background.
    2. Opens WebKit2 on https://www.epicgames.com/id/api/csrf, exchanges the token via
       fetch('/id/api/exchange') so the browser receives authenticated Epic cookies
       automatically (zero re-login!), and redirects straight to the direct purchase
       checkout modal (`https://www.epicgames.com/store/purchase?...`).
    """
    if not target_url or "epicgames.com" not in target_url:
        return {"ok": False, "error": "Invalid store URL"}

    exchange_code = ""
    try:
        from legendary.core import LegendaryCore

        core = LegendaryCore()
        if core.login():
            tok = core.egs.get_game_token()
            exchange_code = tok.get("code", "") if isinstance(tok, dict) else ""
    except Exception:
        exchange_code = ""

    env = os.environ.copy()
    env.setdefault("DISPLAY", ":0")
    storage_dir = os.path.expanduser("~/.config/legendary/webview_session")
    os.makedirs(storage_dir, exist_ok=True)

    py_script = """
import json, sys, webview

target_url = sys.argv[1]
exchange_code = sys.argv[2]
storage_dir = sys.argv[3]

boot_url = "https://www.epicgames.com/account/personal" if exchange_code else target_url
win = webview.create_window("Epic Games — Potvrzení objednávky (0 Kč)", boot_url, width=540, height=720)
state = {"done": False}

def on_loaded():
    if state["done"] or not exchange_code:
        return
    state["done"] = True
    js = f'''
    (async function() {{
        try {{
            await fetch("https://www.epicgames.com/id/api/csrf", {{ credentials: "include" }});
            const m = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
            const xsrf = m ? decodeURIComponent(m[1]) : "";
            await fetch("https://www.epicgames.com/id/api/exchange", {{
                method: "POST",
                credentials: "include",
                headers: {{
                    "Content-Type": "application/json",
                    "X-XSRF-TOKEN": xsrf
                }},
                body: JSON.stringify({{ exchangeCode: {json.dumps(exchange_code)} }})
            }});
        }} catch (e) {{}}
        window.location.replace({json.dumps(target_url)});
    }})();
    '''
    try:
        win.evaluate_js(js)
    except Exception:
        pass

win.events.loaded += on_loaded
webview.start(private_mode=False, storage_path=storage_dir)
"""
    subprocess.Popen(
        [sys.executable, "-c", py_script, target_url, exchange_code, storage_dir],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"ok": True, "url": target_url, "autoLoggedIn": bool(exchange_code)}


def ensure_steamui_injected() -> bool:
    try:
        if os.path.isfile(FRONTEND_SRC):
            shutil.copyfile(FRONTEND_SRC, STEAMUI_SCRIPT)
        if not os.path.isfile(STEAMUI_INDEX):
            return False
        with open(STEAMUI_INDEX, "r", encoding="utf-8") as f:
            html = f.read()
        tag = '<script defer="defer" src="/epic-integration.js"></script>'
        if "epic-integration.js" not in html and "</head>" in html:
            html = html.replace("</head>", tag + "</head>")
            with open(STEAMUI_INDEX, "w", encoding="utf-8") as f:
                f.write(html)
            return True
    except Exception:
        pass
    return False


def dispatch_method(method: str, arg: str = "", extra: dict = None) -> dict:
    extra = extra or {}
    if method in ("free", "GetFreeGames"):
        return get_free_games()
    if method in ("status", "GetAuthStatus"):
        return get_auth_status()
    if method in ("library", "GetEpicLibrary"):
        return get_epic_library()
    if method in ("sync", "SyncSteamShortcuts"):
        return sync_to_steam_shortcuts()
    if method in ("launch", "LaunchOrInstallEpicGame"):
        return launch_or_install_game(arg)
    if method in ("auth", "AuthenticateEpic"):
        return start_auth(arg)
    if method in ("claim", "OpenClaimWindow"):
        return open_claim_window(arg)
    if method == "CacheSteamGridArtwork":
        return cache_steam_grid_artwork(extra.get("items") or [])
    if method == "GetArtworkBase64":
        return get_artwork_base64(
            extra.get("appName", ""),
            extra.get("kind", "tall"),
            extra.get("url", ""),
        )
    if method == "debug_get":
        return LAST_DEBUG_REPORT
    return {"ok": False, "error": f"Unknown method: {method}"}


class EpicRPCHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json({"ok": True})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        method = parsed.path.lstrip("/") or "GetFreeGames"
        arg = (
            qs.get("arg")
            or qs.get("url")
            or qs.get("app_name")
            or qs.get("auth_code")
            or [""]
        )[0]
        self._send_json(dispatch_method(method, arg))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        method = body.get("method") or self.path.lstrip("/")
        args = body.get("args") or {}
        if method == "debug_set":
            global LAST_DEBUG_REPORT
            LAST_DEBUG_REPORT = args if isinstance(args, dict) else {"raw": args}
            self._send_json({"ok": True})
            return
        arg = ""
        extra = {}
        if isinstance(args, dict):
            extra = args
            arg = (
                args.get("url")
                or args.get("app_name")
                or args.get("auth_code")
                or ""
            )
        elif isinstance(args, str):
            arg = args
        self._send_json(dispatch_method(method, arg, extra))


def run_daemon():
    ensure_steamui_injected()

    def watcher():
        while True:
            ensure_steamui_injected()
            time.sleep(10)

    t = threading.Thread(target=watcher, daemon=True)
    t.start()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", DAEMON_PORT), EpicRPCHandler)
    server.serve_forever()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "free"
    arg = sys.argv[2] if len(sys.argv) > 2 else ""

    if cmd == "serve":
        run_daemon()
        return
    if cmd == "inject":
        changed = ensure_steamui_injected()
        print(json.dumps({"ok": True, "injected": changed}))
        return

    res = dispatch_method(cmd, arg)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
