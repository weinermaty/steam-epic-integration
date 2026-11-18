#!/usr/bin/env bash
set -e

echo "==> 1. Odstraňuji duplicitní prázdný Flatpak Steam..."
flatpak uninstall -y com.valvesoftware.Steam || true

echo "==> 2. Instaluji Millennium do /usr/lib/millennium (zadej heslo k PC)..."
sudo cp -r /tmp/millennium_dl/extracted/usr/* /usr/
sudo chmod +x /usr/lib/millennium/libmillennium_pvs64 /usr/lib/millennium/libmillennium_luavm_x86 /usr/lib/millennium/libmillennium_luavm_x64

echo "==> 3. Propojuji Millennium s tvým Steamem..."
mkdir -p "$HOME/.steam/steam/ubuntu12_32" "$HOME/.steam/steam/ubuntu12_64" "$HOME/.steam/steam/steamrt64"
ln -sf /usr/lib/millennium/libmillennium_bootstrap_x86.so   "$HOME/.steam/steam/ubuntu12_32/libXtst.so.6"
ln -sf /usr/lib/millennium/libmillennium_bootstrap_hhx64.so "$HOME/.steam/steam/ubuntu12_64/libXtst.so.6"
ln -sf /usr/lib/millennium/libmillennium_hhx64.so           "$HOME/.steam/steam/ubuntu12_64/libmillennium_hhx64.so"
ln -sf /run/host/usr/lib/millennium/libmillennium_bootstrap_x64.so "$HOME/.steam/steam/steamrt64/libXtst.so.6"

echo "==> Hotovo! Nyní můžeš zapnout (nebo restartovat) Steam."
