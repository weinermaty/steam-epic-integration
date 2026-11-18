# Steam Epic Integration (Millennium Plugin)

Nenápadný plugin v nativním vzhledu Steamu pro **[Millennium (SteamBrew)](https://steambrew.app/)**, který přímo do klienta Steam přidává:

1. **Vyzvedávání Free her z Epic Games Store** – automaticky kontroluje aktuální týdenní hry zdarma (rozsvítí malou modrou tečku u tlačítka `Epic` v horní liště Steamu) a po kliknutí otevře přímý checkout bez nutnosti zapínat Epic Games Launcher.
2. **Spouštění a synchronizaci Epic her bez Epic Launcheru** – využívá open-source CLI **[Legendary](https://github.com/derrod/legendary)** k přihlášení, instalaci, přímému spouštění her a jejich zápisu do `shortcuts.vdf` (jako *Non-Steam Games* přímo ve tvé Knihovně Steamu).

## Struktura projektu

- [`plugin.json`](plugin.json) – manifest pro Millennium.
- [`backend/main.lua`](backend/main.lua) – Lua RPC most pro Millennium.
- [`backend/epic_helper.py`](backend/epic_helper.py) – komunikace s Epic Store API, `legendary` CLI a generátor binárního `shortcuts.vdf`.
- [`frontend/index.js`](frontend/index.js) – nativně stylované UI (barvy a typografie Steamu) injektované do horní lišty Steamu.

## Instalace

1. **Legendary** (`~/.local/bin/legendary`):
   ```bash
   pip install --user legendary-gl
   ```
2. **Millennium**:
   ```bash
   curl -fsSL "https://steambrew.app/install.sh" | bash
   ```
3. **Aktivace pluginu**:
   Složka projektu je nalinkovaná v `~/.local/share/millennium/plugins/steam-epic-integration` a povolená v `~/.config/millennium/config.json`.
