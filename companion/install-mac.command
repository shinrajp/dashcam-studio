#!/bin/bash
# Double-click (or run) to install the Tesla Dashcam Studio companion so it starts at every login.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
missing=()
command -v node   >/dev/null || missing+=("node")
command -v ffmpeg >/dev/null || missing+=("ffmpeg")
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing: ${missing[*]}"
  if command -v brew >/dev/null; then
    read -r -p "Install with Homebrew now (brew install ${missing[*]})? [Y/n] " a
    [[ "$a" =~ ^[Nn] ]] && exit 1
    brew install "${missing[@]}" || exit 1
  else
    echo "Install Homebrew from https://brew.sh, then run: brew install ${missing[*]}"; exit 1
  fi
fi
node dashcam-companion.js install
echo; read -r -p "Press Return to close." _
