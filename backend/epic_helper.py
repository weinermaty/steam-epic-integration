#!/usr/bin/env python3
"""
Backend helper & local daemon for steam-epic-integration.
Handles:
1. Fetching active Epic Games Store free games promotions.
2. Reading Epic Games library & auth status via Legendary CLI.
3. Seamless 1-click Epic Games login via native WebKit2/pywebview window (no manual code copying).
4. Syncing / unsyncing Epic Games in Steam's shortcuts.vdf + providing executable paths for live SteamClient.Apps.AddShortcut/RemoveShortcut.
5. Installing / Launching Epic games via Legendary CLI (auto-installs if not yet installed when launched from Steam Library).
"""

import binascii
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


def find_legendary() -> str:
    path = shutil.which("legendary")
    if path:
        return path
    local_bin = os.path.expanduser("~/.local/bin/legendary")
    if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
        return local_bin
    return "legendary"


def get_free_games() -> dict:
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

            store_url = (
                f"https://store.epicgames.com/en-US/p/{slug}"
                if slug
                else "https://store.epicgames.com/en-US/free-games"
            )
            games.append(
                {
                    "id": el.get("id", ""),
                    "title": el.get("title", "Unknown Game"),
                    "description": el.get("description", ""),
                    "image": img_url,
                    "endDate": offer.get("endDate", ""),
                    "storeUrl": store_url,
                }
            )
        return {"ok": True, "games": games}
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

    leg = find_legendary()
    installed_map = {}
    installed_json = os.path.expanduser("~/.config/legendary/installed.json")
    if os.path.isfile(installed_json):
        try:
            with open(installed_json, "r", encoding="utf-8") as f:
                installed_map = json.load(f)
        except Exception:
            installed_map = {}

    try:
        proc = subprocess.run(
            [leg, "list", "--json"],
            capture_output=True,
            text=True,
            timeout=25,
        )
        items = json.loads(proc.stdout) if proc.returncode == 0 and proc.stdout else []
    except Exception as exc:
        return {
            "ok": False,
            "authenticated": True,
            "helperPath": helper_path,
            "error": str(exc),
            "games": [],
        }

    games = []
    for item in items:
        if item.get("is_dlc"):
            continue
        app_name = item.get("app_name", "")
        title = item.get("app_title", app_name)
        games.append(
            {
                "appName": app_name,
                "title": title,
                "installed": app_name in installed_map,
                "installPath": installed_map.get(app_name, {}).get("install_path", ""),
            }
        )
    games.sort(key=lambda g: (not g["installed"], g["title"].lower()))
    return {
        "ok": True,
        "authenticated": True,
        "displayName": auth["displayName"],
        "helperPath": helper_path,
        "games": games,
    }


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
        # Install first, then automatically launch once download completes
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
        # Spawn interactive pywebview login window (user just logs in, no code copying needed)
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


LAST_DEBUG_REPORT = {}


def dispatch_method(method: str, arg: str = "") -> dict:
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
        arg = (qs.get("arg") or qs.get("app_name") or qs.get("auth_code") or [""])[0]
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
        if isinstance(args, dict):
            arg = args.get("app_name") or args.get("auth_code") or ""
        elif isinstance(args, str):
            arg = args
        self._send_json(dispatch_method(method, arg))


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
