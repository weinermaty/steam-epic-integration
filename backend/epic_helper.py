#!/usr/bin/env python3
"""
Backend helper & local daemon for steam-epic-integration.
Handles:
1. Fetching active Epic Games Store free games promotions (with offerId & namespace for direct 1-step checkout).
2. Reading Epic Games library & auth status from ~/.config/legendary/metadata/*.json (with force_refresh support right after claiming a new game).
3. Seamless 1-click Epic Games login via native WebKit2/pywebview window.
4. Direct 1-step free game claim window using native GTK+WebKit2+Soup:
   - Exchanges Legendary OAuth token for a 32-char opaque EPIC_BEARER_TOKEN (under WebKit's 4 KB cookie limit).
   - Sets HttpOnly cookie via WebKit2.CookieManager, loads store.epicgames.com/en-US/cart to mint EPIC_EG1,
     and immediately opens the direct `#/free-checkout` dialog ("Add to library" / hCaptcha, zero login prompt!).
   - Automatically triggers a library refresh when the checkout completes or window closes.
5. Epic Games Updates & Downloads tracking (`GetEpicUpdates`, `UpdateEpicGame`) integrated directly into Steam's Downloads page (`_1bq4x9pa4-9RLY-dXWUZTp`).
6. Background Steam artwork downloader (`CacheSteamGridArtwork`, `GetArtworkBase64`).
"""

import base64
import binascii
import concurrent.futures
import glob
import hashlib
import http.server
import json
import os
import re
import shutil
import socket
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
_LAST_CLAIM_COMPLETED_TS = 0.0

# Active & completed Epic downloads/updates tracked for Steam's Downloads page
_ACTIVE_DOWNLOADS = {}  # appName -> {appName, title, status, progress, speed, eta, updatedAt}
_DOWNLOADS_LOCK = threading.Lock()


def find_legendary() -> str:
    path = shutil.which("legendary")
    if path:
        return path
    local_bin = os.path.expanduser("~/.local/bin/legendary")
    if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
        return local_bin
    return "legendary"


def get_free_games(force: bool = False) -> dict:
    now = time.time()
    if not force and _CACHED_FREE["data"] and now - _CACHED_FREE["ts"] < 300:
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
                "lastClaimTs": _LAST_CLAIM_COMPLETED_TS,
            }
        except Exception:
            pass
    return {"authenticated": False, "displayName": None, "lastClaimTs": 0}


def refresh_epic_metadata() -> bool:
    """Fetches newly claimed games from Epic servers into ~/.config/legendary/metadata/."""
    try:
        from legendary.core import LegendaryCore

        core = LegendaryCore()
        if core.login():
            core.get_game_and_dlc_list(update_assets=True)
            return True
    except Exception:
        try:
            subprocess.run(
                [find_legendary(), "list", "--json"],
                capture_output=True,
                text=True,
                timeout=25,
            )
            return True
        except Exception:
            pass
    return False


def get_epic_library(force_refresh: bool = False) -> dict:
    auth = get_auth_status()
    helper_path = os.path.abspath(__file__)
    if not auth["authenticated"]:
        return {
            "ok": True,
            "authenticated": False,
            "helperPath": helper_path,
            "games": [],
        }

    meta_dir = os.path.expanduser("~/.config/legendary/metadata")
    meta_files = glob.glob(os.path.join(meta_dir, "*.json"))

    if force_refresh or not meta_files:
        refresh_epic_metadata()
        meta_files = glob.glob(os.path.join(meta_dir, "*.json"))

    installed_map = {}
    installed_json = os.path.expanduser("~/.config/legendary/installed.json")
    if os.path.isfile(installed_json):
        try:
            with open(installed_json, "r", encoding="utf-8") as f:
                installed_map = json.load(f)
        except Exception:
            installed_map = {}

    games = []
    for mf in meta_files:
        try:
            with open(mf, "r", encoding="utf-8") as f:
                item = json.load(f)
            meta = item.get("metadata", {})
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
            inst_info = installed_map.get(app_name, {})
            games.append(
                {
                    "appName": app_name,
                    "title": title,
                    "installed": app_name in installed_map,
                    "installPath": inst_info.get("install_path", ""),
                    "installedVersion": inst_info.get("version", ""),
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
        "lastClaimTs": _LAST_CLAIM_COMPLETED_TS,
        "games": games,
    }


def get_epic_updates_and_downloads(check_remote: bool = False) -> dict:
    """
    Returns installed Epic games that have an update available, plus any active/completed
    Legendary downloads/updates so the frontend can render them in Steam's Downloads window.
    """
    updates = []
    try:
        from legendary.core import LegendaryCore

        core = LegendaryCore()
        if check_remote and core.login():
            for plat in core.get_installed_platforms():
                core.get_assets(update_assets=True, platform=plat)

        installed_games = core.get_installed_list(include_dlc=False)
        for ig in installed_games:
            try:
                latest_ver = core.get_asset(ig.app_name, platform=ig.platform).build_version
            except Exception:
                latest_ver = ig.version
            has_update = bool(latest_ver and ig.version and latest_ver != ig.version)
            updates.append(
                {
                    "appName": ig.app_name,
                    "title": ig.title,
                    "installedVersion": ig.version,
                    "latestVersion": latest_ver,
                    "hasUpdate": has_update,
                    "installSize": ig.install_size,
                }
            )
    except Exception:
        pass

    with _DOWNLOADS_LOCK:
        transfers = list(_ACTIVE_DOWNLOADS.values())

    return {
        "ok": True,
        "installedGames": updates,
        "pendingUpdates": [u for u in updates if u["hasUpdate"]],
        "activeTransfers": transfers,
    }


def _find_proton_binary() -> str:
    candidates = [
        os.path.expanduser("~/.steam/steam/steamapps/common/Proton - Experimental/proton"),
    ]
    candidates.extend(
        sorted(glob.glob(os.path.expanduser("~/.steam/steam/steamapps/common/Proton*/proton")), reverse=True)
    )
    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return ""


def _build_launch_cmd(leg: str, app_name: str, platform: str = "") -> tuple[list[str], dict[str, str]]:
    env = os.environ.copy()
    if platform.lower() == "linux" or shutil.which("wine"):
        return [leg, "launch", app_name], env

    proton_path = _find_proton_binary()
    if not proton_path:
        return [leg, "launch", app_name], env

    safe_id = "".join(c for c in app_name if c.isalnum() or c in "-_")
    pfx_dir = os.path.expanduser(f"~/.local/share/steam-epic-integration/pfx/{safe_id}")
    os.makedirs(pfx_dir, exist_ok=True)
    env["STEAM_COMPAT_DATA_PATH"] = pfx_dir
    env["STEAM_COMPAT_CLIENT_INSTALL_PATH"] = os.path.expanduser("~/.steam/steam")
    return [leg, "launch", "--no-wine", "--wrapper", f'"{proton_path}" run', app_name], env


def _run_legendary_transfer(app_name: str, title: str, mode: str = "update", auto_launch: bool = False):
    leg = find_legendary()
    with _DOWNLOADS_LOCK:
        existing = _ACTIVE_DOWNLOADS.get(app_name)
        if existing and existing.get("status") == "downloading":
            return
        _ACTIVE_DOWNLOADS[app_name] = {
            "appName": app_name,
            "title": title or app_name,
            "mode": mode,
            "status": "downloading",
            "progress": 0.0,
            "speed": "",
            "eta": "",
            "updatedAt": time.time(),
        }

    if mode == "update":
        cmd = [leg, "update", "-y", app_name]
    else:
        base_path = os.path.expanduser("~/Games/Epic")
        os.makedirs(base_path, exist_ok=True)
        cmd = [leg, "install", "-y", "--base-path", base_path, app_name]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        pct_re = re.compile(r"Progress:\s*([0-9.]+)%")
        speed_re = re.compile(r"Download\s*-\s*([0-9.]+\s*[KMG]i?B/s)")
        eta_re = re.compile(r"ETA:\s*([0-9:]+)")

        for line in proc.stdout:
            m_pct = pct_re.search(line)
            m_spd = speed_re.search(line)
            m_eta = eta_re.search(line)
            if m_pct or m_spd or m_eta:
                with _DOWNLOADS_LOCK:
                    entry = _ACTIVE_DOWNLOADS.get(app_name)
                    if entry:
                        if m_pct:
                            entry["progress"] = float(m_pct.group(1))
                        if m_spd:
                            entry["speed"] = m_spd.group(1)
                        if m_eta:
                            entry["eta"] = m_eta.group(1)
                        entry["updatedAt"] = time.time()
        proc.wait()
        ok = proc.returncode == 0
    except Exception:
        ok = False

    with _DOWNLOADS_LOCK:
        entry = _ACTIVE_DOWNLOADS.get(app_name)
        if entry:
            entry["status"] = "completed" if ok else "failed"
            entry["progress"] = 100.0 if ok else entry["progress"]
            entry["speed"] = ""
            entry["eta"] = ""
            entry["updatedAt"] = time.time()

    if ok and auto_launch:
        launch_cmd, launch_env = _build_launch_cmd(leg, app_name)
        subprocess.Popen(
            launch_cmd,
            env=launch_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )


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
    sized_url = (
        f"{url}{sep}h=600&w=400&resize=1"
        if kind == "tall"
        else f"{url}{sep}h=430&w=920&resize=1"
    )
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


def _ensure_png_icon(app_name: str, jpg_bytes: bytes) -> str:
    """Converts tall/wide JPEG bytes into a 64x64 PNG file for Steam's left-sidebar SetShortcutIcon."""
    if not jpg_bytes:
        return ""
    os.makedirs(ARTWORK_CACHE_DIR, exist_ok=True)
    safe_id = "".join(c for c in app_name if c.isalnum() or c in "-_")
    icon_path = os.path.join(ARTWORK_CACHE_DIR, f"{safe_id}_icon.png")
    if os.path.isfile(icon_path) and os.path.getsize(icon_path) > 100:
        return icon_path
    try:
        import io
        from PIL import Image

        img = Image.open(io.BytesIO(jpg_bytes)).convert("RGBA")
        w, h = img.size
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize(
            (64, 64), Image.Resampling.LANCZOS
        )
        img.save(icon_path, format="PNG")
        return icon_path
    except Exception:
        return ""


def cache_steam_grid_artwork(items: list) -> dict:
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
        _ensure_png_icon(app_name, tall_bytes or wide_bytes)
        for gdir in grid_dirs:
            if tall_bytes:
                p = os.path.join(gdir, f"{appid}p.jpg")
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


def get_artwork_base64(app_name: str, tall_url: str, wide_url: str) -> dict:
    tall_data = _download_artwork_bytes(app_name, "tall", tall_url)
    wide_data = _download_artwork_bytes(app_name, "wide", wide_url)
    icon_path = _ensure_png_icon(app_name, tall_data or wide_data)
    icon_b64 = ""
    if icon_path and os.path.isfile(icon_path):
        try:
            with open(icon_path, "rb") as f:
                icon_b64 = base64.b64encode(f.read()).decode("ascii")
        except Exception:
            pass
    if not tall_data and not wide_data:
        return {"ok": False}
    return {
        "ok": True,
        "tallBase64": base64.b64encode(tall_data).decode("ascii") if tall_data else "",
        "wideBase64": base64.b64encode(wide_data).decode("ascii") if wide_data else "",
        "iconPath": icon_path,
        "iconBase64": icon_b64,
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


def launch_or_install_game(app_name: str, title: str = "", blocking: bool = False) -> dict:
    if not app_name or not all(c.isalnum() or c in "-_." for c in app_name):
        return {"ok": False, "error": "Invalid app_name"}

    leg = find_legendary()
    installed_json = os.path.expanduser("~/.config/legendary/installed.json")
    is_installed = False
    game_title = title or app_name
    platform = ""
    if os.path.isfile(installed_json):
        try:
            with open(installed_json, "r", encoding="utf-8") as f:
                inst_data = json.load(f)
                is_installed = app_name in inst_data
                if is_installed:
                    if not title:
                        game_title = inst_data[app_name].get("title", app_name)
                    platform = inst_data[app_name].get("platform", "")
        except Exception:
            pass

    if is_installed:
        # Check if an update is required before launching
        needs_update = False
        try:
            from legendary.core import LegendaryCore

            core = LegendaryCore()
            ig = core.get_installed_game(app_name)
            if ig:
                game_title = ig.title or game_title
                platform = ig.platform or platform
                asset = core.get_asset(app_name, platform=ig.platform)
                if asset and asset.build_version and asset.build_version != ig.version:
                    needs_update = True
        except Exception:
            pass

        if needs_update:
            if blocking:
                _run_legendary_transfer(app_name, game_title, "update", True)
            else:
                threading.Thread(
                    target=_run_legendary_transfer,
                    args=(app_name, game_title, "update", True),
                    daemon=True,
                ).start()
            return {"ok": True, "action": "updating_and_launching", "appName": app_name}

        launch_cmd, launch_env = _build_launch_cmd(leg, app_name, platform=platform)
        proc = subprocess.Popen(
            launch_cmd,
            env=launch_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        if blocking:
            proc.wait()
        return {"ok": True, "action": "launched", "appName": app_name}
    else:
        if not title:
            try:
                from legendary.core import LegendaryCore

                g = LegendaryCore().get_game(app_name)
                if g and getattr(g, "app_title", None):
                    game_title = g.app_title
            except Exception:
                pass
        if blocking:
            _run_legendary_transfer(app_name, game_title, "install", True)
        else:
            threading.Thread(
                target=_run_legendary_transfer,
                args=(app_name, game_title, "install", True),
                daemon=True,
            ).start()
        return {"ok": True, "action": "installing", "appName": app_name}


def update_epic_game(app_name: str, title: str = "") -> dict:
    if not app_name or not all(c.isalnum() or c in "-_." for c in app_name):
        return {"ok": False, "error": "Invalid app_name"}
    threading.Thread(
        target=_run_legendary_transfer,
        args=(app_name, title or app_name, "update", False),
        daemon=True,
    ).start()
    return {"ok": True, "action": "updating", "appName": app_name}


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


_PREWARMED_CLAIM = {"ts": 0.0, "token": ""}
_PREWARM_LOCK = threading.Lock()


def _mint_short_bearer_token() -> str:
    try:
        import requests
        from legendary.core import LegendaryCore

        core = LegendaryCore()
        if core.login():
            account_id = core.lgd.userdata.get("account_id", "")
            if account_id:
                for eula_key in ("epicgames_privacy_policy_no_table", "egstore"):
                    try:
                        eula_url = f"https://eulatracking-public-service-prod-m.ol.epicgames.com/eulatracking/api/public/agreements/{eula_key}/account/{account_id}"
                        r = core.egs.session.get(eula_url, timeout=5)
                        if r.status_code == 200 and r.text:
                            edata = r.json()
                            if edata and "version" in edata:
                                ver = edata["version"]
                                loc = edata.get("locale", "en-US")
                                acc_url = f"https://eulatracking-public-service-prod-m.ol.epicgames.com/eulatracking/api/public/agreements/{eula_key}/version/{ver}/account/{account_id}/accept?locale={loc}"
                                core.egs.session.post(acc_url, timeout=5)
                    except Exception:
                        pass

            code = core.egs.get_game_token().get("code", "")
            if code:
                resp = requests.post(
                    "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token",
                    data={"grant_type": "exchange_code", "exchange_code": code},
                    auth=(
                        "34a02cf8f4414e29b15921876da36f9a",
                        "daafbccc737745039dffe53d94fc76cf",
                    ),
                    timeout=8,
                )
                if resp.status_code == 200:
                    return resp.json().get("access_token", "")
    except Exception:
        pass
    return ""


def _prewarm_claim_session_async():
    def _worker():
        tok = _mint_short_bearer_token()
        if tok:
            with _PREWARM_LOCK:
                _PREWARMED_CLAIM["token"] = tok
                _PREWARMED_CLAIM["ts"] = time.time()
    threading.Thread(target=_worker, daemon=True).start()


def open_claim_window(target_url: str) -> dict:
    """
    Opens a compact GTK+WebKit2 checkout window pre-authenticated with the user's Legendary session!
    - Uses pre-warmed 32-char opaque EPIC_BEARER_TOKEN (0 ms API wait on click) and refreshes
      the next token asynchronously in the background.
    - Shows the dark Steam-styled window immediately on click.
    - If EPIC_EG1 is already cached in webkit_cookies.sqlite, navigates straight to `#/free-checkout`
      without an extra `/cart` round-trip.
    """
    if not target_url or "epicgames.com" not in target_url:
        return {"ok": False, "error": "Invalid store URL"}

    short_bearer_token = ""
    with _PREWARM_LOCK:
        if _PREWARMED_CLAIM["token"] and time.time() - _PREWARMED_CLAIM["ts"] < 1200:
            short_bearer_token = _PREWARMED_CLAIM["token"]
            _PREWARMED_CLAIM["token"] = ""
            _PREWARMED_CLAIM["ts"] = 0.0

    if not short_bearer_token:
        short_bearer_token = _mint_short_bearer_token()

    # Pre-warm next token for future claims
    _prewarm_claim_session_async()

    env = os.environ.copy()
    env.setdefault("DISPLAY", ":0")
    cookie_db = os.path.expanduser("~/.config/legendary/webkit_cookies.sqlite")

    py_script = """
import os, sys, urllib.request
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("Soup", "3.0")
from gi.repository import Gtk, Gdk, WebKit2, Soup, GLib

target_url = sys.argv[1]
short_token = sys.argv[2]
cookie_db = sys.argv[3]
daemon_port = sys.argv[4]

ctx = WebKit2.WebContext.get_default()
cm = ctx.get_cookie_manager()
cm.set_persistent_storage(cookie_db, WebKit2.CookiePersistentStorage.SQLITE)

win = Gtk.Window(title="Epic Games — Vyzvednout zdarma (0 Kč)")
win.set_default_size(560, 740)
win.set_position(Gtk.WindowPosition.CENTER)

wv = WebKit2.WebView.new_with_context(ctx)
wv.set_background_color(Gdk.RGBA(0.09, 0.11, 0.145, 1.0))
settings = wv.get_settings()
settings.set_user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
win.add(wv)
wv.load_html("<html><body style='background:#171d25;color:#8b929a;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><div>Připravuji pokladnu Epic Games…</div></body></html>", "https://store.epicgames.com/")
win.show_all()

def notify_claim_done(*_):
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{daemon_port}/NotifyClaimCompleted",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass
    Gtk.main_quit()

win.connect("destroy", notify_claim_done)

navigated = {"done": False}

def poll_cookies():
    def cb(mgr, res, _):
        try:
            cks = mgr.get_cookies_finish(res)
            names = [x.get_name() for x in cks]
            if "EPIC_EG1" in names and not navigated["done"]:
                navigated["done"] = True
                wv.load_uri(target_url)
                return
        except Exception:
            pass
        if not navigated["done"]:
            GLib.timeout_add(250, poll_cookies)
    cm.get_cookies("https://store.epicgames.com/", None, cb, None)
    return False

def start_flow():
    def on_existing_cookies(mgr, res, _):
        try:
            cks = mgr.get_cookies_finish(res)
            if any(x.get_name() == "EPIC_EG1" for x in cks):
                navigated["done"] = True
                wv.load_uri(target_url)
                return
        except Exception:
            pass

        if short_token:
            ck = Soup.Cookie.new("EPIC_BEARER_TOKEN", short_token, ".epicgames.com", "/", 86400)
            ck.set_secure(True)
            ck.set_http_only(True)
            ck.set_same_site_policy(Soup.SameSitePolicy.LAX)

            def on_added(m, r, _u):
                try:
                    m.add_cookie_finish(r)
                except Exception:
                    pass
                wv.load_uri("https://store.epicgames.com/en-US/cart")
                GLib.timeout_add(400, poll_cookies)

            cm.add_cookie(ck, None, on_added, None)
        else:
            wv.load_uri(target_url)

    cm.get_cookies("https://store.epicgames.com/", None, on_existing_cookies, None)
    return False

GLib.idle_add(start_flow)
Gtk.main()
"""
    subprocess.Popen(
        [
            sys.executable,
            "-c",
            py_script,
            target_url,
            short_bearer_token,
            cookie_db,
            str(DAEMON_PORT),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"ok": True, "url": target_url, "autoLoggedIn": bool(short_bearer_token)}


def notify_claim_completed() -> dict:
    global _LAST_CLAIM_COMPLETED_TS
    def _bg():
        global _LAST_CLAIM_COMPLETED_TS
        refresh_epic_metadata()
        get_free_games(force=True)
        _LAST_CLAIM_COMPLETED_TS = time.time()
    threading.Thread(target=_bg, daemon=True).start()
    return {"ok": True}


_CDP_INJECTED_KEY = None


def _cdp_eval(ws_url: str, js_code: str) -> bool:
    parsed = urllib.parse.urlparse(ws_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8080
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    sock = socket.create_connection((host, port), timeout=3)
    try:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        sock.sendall(req)

        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = sock.recv(4096)
            if not chunk:
                return False
            resp += chunk
        if b"101 " not in resp.split(b"\r\n", 1)[0]:
            return False

        payload = json.dumps(
            {
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {"expression": js_code, "includeCommandLineAPI": False},
            }
        ).encode("utf-8")

        mask = os.urandom(4)
        header = bytearray([0x81])
        plen = len(payload)
        if plen < 126:
            header.append(0x80 | plen)
        elif plen < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", plen))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", plen))
        header.extend(mask)

        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        sock.sendall(bytes(header) + masked)
        sock.recv(4096)
        return True
    finally:
        sock.close()


def _ensure_cdp_injected() -> bool:
    global _CDP_INJECTED_KEY
    if not os.path.isfile(FRONTEND_SRC):
        return False
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/json", timeout=1.5) as resp:
            targets = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return False

    target = None
    for t in targets:
        if t.get("title") == "SharedJSContext" or "steamloopback.host/index.html" in t.get("url", ""):
            if t.get("webSocketDebuggerUrl"):
                target = t
                break
    if not target:
        return False

    mtime = os.path.getmtime(FRONTEND_SRC)
    key = (target.get("id"), mtime)
    if _CDP_INJECTED_KEY == key:
        return False

    try:
        with open(FRONTEND_SRC, "r", encoding="utf-8") as f:
            js_code = f.read()
        if _cdp_eval(target["webSocketDebuggerUrl"], js_code):
            _CDP_INJECTED_KEY = key
            return True
    except Exception:
        pass
    return False


def ensure_steamui_injected() -> bool:
    # Keep steamui/index.html untouched so Steam never triggers "Extracting package" on startup
    try:
        if os.path.isfile(STEAMUI_INDEX):
            with open(STEAMUI_INDEX, "r", encoding="utf-8") as f:
                html = f.read()
            tag = '<script defer="defer" src="/epic-integration.js"></script>'
            if tag in html:
                with open(STEAMUI_INDEX, "w", encoding="utf-8") as f:
                    f.write(html.replace(tag, ""))
        if os.path.isfile(STEAMUI_SCRIPT):
            os.remove(STEAMUI_SCRIPT)
    except Exception:
        pass

    # Enable Steam's built-in CEF remote debugging flag without modifying Steam binaries/packages
    try:
        cef_flag = os.path.expanduser("~/.steam/steam/.cef-enable-remote-debugging")
        if os.path.isdir(os.path.dirname(cef_flag)) and not os.path.exists(cef_flag):
            with open(cef_flag, "w", encoding="utf-8"):
                pass
    except Exception:
        pass

    return _ensure_cdp_injected()


def dispatch_method(method: str, arg: str = "", extra: dict = None) -> dict:
    extra = extra or {}
    if method in ("free", "GetFreeGames"):
        return get_free_games(force=bool(extra.get("force")))
    if method in ("status", "GetAuthStatus"):
        return get_auth_status()
    if method in ("library", "GetEpicLibrary"):
        return get_epic_library(force_refresh=bool(extra.get("forceRefresh")))
    if method in ("updates", "GetEpicUpdates"):
        return get_epic_updates_and_downloads(check_remote=bool(extra.get("checkRemote")))
    if method in ("update_game", "UpdateEpicGame"):
        return update_epic_game(arg, extra.get("title", ""))
    if method in ("sync", "SyncSteamShortcuts"):
        return sync_to_steam_shortcuts()
    if method in ("launch", "LaunchOrInstallEpicGame"):
        return launch_or_install_game(arg, extra.get("title", ""))
    if method in ("auth", "AuthenticateEpic"):
        return start_auth(arg)
    if method in ("claim", "OpenClaimWindow"):
        return open_claim_window(arg)
    if method == "NotifyClaimCompleted":
        return notify_claim_completed()
    if method == "CacheSteamGridArtwork":
        return cache_steam_grid_artwork(extra.get("items") or [])
    if method == "GetArtworkBase64":
        return get_artwork_base64(
            extra.get("appName", ""),
            extra.get("tallCover", "") or extra.get("url", ""),
            extra.get("wideCover", "") or extra.get("url", ""),
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
    _prewarm_claim_session_async()

    def watcher():
        while True:
            ensure_steamui_injected()
            time.sleep(1)

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
    if cmd == "launch" and arg:
        try:
            url = f"http://127.0.0.1:{DAEMON_PORT}/LaunchOrInstallEpicGame?app_name={urllib.parse.quote(arg)}"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("ok"):
                    print(json.dumps(data, ensure_ascii=False))
                    return
        except Exception:
            pass
        res = launch_or_install_game(arg, blocking=True)
        print(json.dumps(res, ensure_ascii=False))
        return

    res = dispatch_method(cmd, arg)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
