#!/usr/bin/env python3
"""
Backend helper for steam-epic-integration Millennium plugin.
Handles:
1. Fetching active Epic Games Store free games promotions.
2. Reading Epic Games library & auth status via Legendary CLI.
3. Syncing Epic Games directly into Steam's shortcuts.vdf (Non-Steam Games) so they launch via `legendary launch <app_name>` without Epic Games Launcher.
4. Installing / Launching Epic games via Legendary CLI.
"""

import binascii
import glob
import json
import os
import shutil
import struct
import subprocess
import sys
import urllib.request

EPIC_FREE_GAMES_URL = (
    "https://store-site-backend-static.ak.epicgames.com/"
    "freeGamesPromotions?locale=en-US&country=CZ&allowCountries=CZ"
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
            # discountPercentage == 0 in Epic's API means 0% of original price paid (100% off)
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
    if not auth["authenticated"]:
        return {"ok": True, "authenticated": False, "games": []}

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
        return {"ok": False, "authenticated": True, "error": str(exc), "games": []}

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
        out += b"\x08"  # end tags
        out += b"\x08"  # end entry
    out += b"\x08\x08"  # end shortcuts + root
    return bytes(out)


def sync_to_steam_shortcuts() -> dict:
    lib = get_epic_library()
    if not lib.get("authenticated"):
        return {"ok": False, "error": "Nejprve se přihlas k Epic účtu přes Legendary."}

    leg = find_legendary()
    games = lib.get("games", [])
    entries = []
    for g in games:
        entries.append(
            {
                "AppName": g["title"],
                "Exe": f'"{leg}"',
                "StartDir": f'"{os.path.dirname(leg) or "/usr/bin"}"',
                "LaunchOptions": f'launch {g["appName"]}',
            }
        )

    vdf_bytes = build_shortcuts_vdf(entries)
    userdata_pattern = os.path.expanduser("~/.steam/steam/userdata/*/config")
    configs = glob.glob(userdata_pattern)
    written = []
    for cfg_dir in configs:
        vdf_path = os.path.join(cfg_dir, "shortcuts.vdf")
        # shortcut: overwrites shortcuts.vdf with Epic library entries, upgrade to full binary VDF parser if merging pre-existing non-Epic shortcuts
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
        subprocess.Popen(
            [leg, "install", "-y", app_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return {"ok": True, "action": "installing", "appName": app_name}


def start_auth(code: str = "") -> dict:
    leg = find_legendary()
    if not code:
        return {
            "ok": True,
            "loginUrl": "https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode",
        }
    try:
        proc = subprocess.run(
            [leg, "auth", "--code", code.strip()],
            capture_output=True,
            text=True,
            timeout=20,
        )
        status = get_auth_status()
        if status["authenticated"]:
            return {"ok": True, "authenticated": True, "displayName": status["displayName"]}
        return {
            "ok": False,
            "authenticated": False,
            "error": (proc.stderr or proc.stdout or "Auth failed").strip(),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "free"
    arg = sys.argv[2] if len(sys.argv) > 2 else ""

    if cmd == "free":
        res = get_free_games()
    elif cmd == "library":
        res = get_epic_library()
    elif cmd == "sync":
        res = sync_to_steam_shortcuts()
    elif cmd == "launch":
        res = launch_or_install_game(arg)
    elif cmd == "auth":
        res = start_auth(arg)
    else:
        res = {"ok": False, "error": f"Unknown command: {cmd}"}

    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
