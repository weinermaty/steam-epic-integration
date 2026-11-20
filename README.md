# Steam Epic Integration

[![Tests](https://github.com/weinermaty/steam-epic-integration/actions/workflows/test.yml/badge.svg)](https://github.com/weinermaty/steam-epic-integration/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Linux](https://img.shields.io/badge/Platform-Linux-lightgrey.svg)](#requirements)

A **[Millennium](https://steambrew.app/)** plugin for Steam on Linux that brings your Epic Games library, weekly freebies, and downloads directly into the native Steam client — powered by **[Legendary](https://github.com/derrod/legendary)**, with no Epic Games Launcher required.

## Features

- **Weekly Free Games** — Checks Epic Games Store promotions in the background, highlights available freebies with a subtle indicator in Steam's top bar, and opens a pre-authenticated 1-step checkout window (via WebKit2) so you can claim them without signing in again.
- **Native Steam Library Integration** — Displays your Epic games alongside Steam games with native styling, sidebar badges, Ready-to-Play filter sync, game size & playtime stats, and automatic Proton detection for Windows titles on Linux.
- **Downloads & Updates in Steam** — Surfaces Epic installs and updates directly inside Steam's Downloads page with working **Pause**, **Resume**, **Cancel**, and **Uninstall** controls.
- **Non-Steam Shortcuts & Artwork** — Syncs installed games to Steam's binary `shortcuts.vdf` and caches Steam Grid artwork in the background.
- **Auto-detected UI Language** — Automatically switches between English and Czech based on your Steam client language.

## Requirements

- **Linux** with the desktop **Steam** client
- **[Millennium](https://steambrew.app/)** installed and enabled
- **[Legendary](https://github.com/derrod/legendary)** (`pip install --user legendary-gl`)
- **Python 3** with GTK / WebKit2 bindings (used for the Epic login and free-game claim window)

## Installation

1. Install **Legendary** and **Millennium** if you haven't already:
   ```bash
   pip install --user legendary-gl
   curl -fsSL "https://steambrew.app/install.sh" | bash
   ```

2. Clone this repository and link it into Millennium's plugins directory:
   ```bash
   git clone https://github.com/weinermaty/steam-epic-integration.git
   cd steam-epic-integration
   ./setup.sh
   ```
   Or link it manually:
   ```bash
   mkdir -p ~/.local/share/millennium/plugins
   ln -sfn "$(pwd)" ~/.local/share/millennium/plugins/steam-epic-integration
   ```

3. Enable **Epic Games Integration** in Millennium's plugin settings and restart Steam.

## How It Works

```
frontend/index.js          Steam UI injection (top bar, sidebar, PlayBar, Downloads)
       │
       ▼  (Millennium RPC)
backend/main.lua           Lua bridge forwarding calls to the Python helper
       │
       ▼  (HTTP / CLI)
backend/epic_helper.py     Local daemon (127.0.0.1:49812), Epic Store API,
                           Legendary CLI wrapper, WebKit2 claim window, shortcuts.vdf
```

## Development & Tests

Run the unit tests:

```bash
python3 -m unittest discover -s tests -v
```

## License

[MIT](LICENSE)
