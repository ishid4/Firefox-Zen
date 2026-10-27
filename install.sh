#!/usr/bin/env bash
# Firefox-Zen installer for macOS and Linux. Run in a terminal:
#   curl -fsSL https://raw.githubusercontent.com/ishid4/Firefox-Zen/main/install.sh | bash
# Running it again updates an existing install.
# FIREFOX_ZEN_PROFILE=<profile folder> skips the profile picker;
# FIREFOX_ZEN_FIREFOX=<install folder> sets where Firefox is installed.

set -euo pipefail

repo="https://github.com/ishid4/Firefox-Zen"

say() { printf '%s\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# stdin is the script itself when piped from curl, so questions read the terminal
ask() {
  local reply
  printf '%s' "$1" >&2
  { read -r reply < /dev/tty; } 2> /dev/null || { printf '\n' >&2; return 1; }
  printf '%s' "$reply"
}

# Where Firefox keeps profiles, caches and its program files
case "$(uname -s)" in
  Darwin)
    data="$HOME/Library/Application Support/Firefox"
    cache="$HOME/Library/Caches/Firefox"
    candidates=("/Applications/Firefox.app/Contents/Resources" "$HOME/Applications/Firefox.app/Contents/Resources")
    ;;
  Linux)
    if [ -f "$HOME/.mozilla/firefox/profiles.ini" ]; then
      data="$HOME/.mozilla/firefox"
    else
      data="${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox"
    fi
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/mozilla/firefox"
    candidates=()
    if command -v firefox > /dev/null; then
      candidates+=("$(dirname "$(readlink -f "$(command -v firefox)")")")
    fi
    candidates+=(/usr/lib/firefox /usr/lib64/firefox /usr/lib/firefox-esr /opt/firefox /usr/local/lib/firefox)
    ;;
  *)
    fail "This installer is for macOS and Linux. On Windows use install.ps1 (see README)."
    ;;
esac

# Firefox install folder: the one with application.ini (a wrapper script's folder has none)
ffdir="${FIREFOX_ZEN_FIREFOX:-}"
if [ -z "$ffdir" ]; then
  for dir in "${candidates[@]}"; do
    if [ -f "$dir/application.ini" ]; then ffdir="$dir"; break; fi
  done
fi
if [ -z "$ffdir" ]; then
  if command -v snap > /dev/null && snap list firefox > /dev/null 2>&1; then
    fail "Firefox is installed as a Snap, whose program folder can't be changed. Install Firefox from Mozilla's .deb/.tar.bz2 instead (see README)."
  fi
  if command -v flatpak > /dev/null && flatpak info org.mozilla.firefox > /dev/null 2>&1; then
    fail "Firefox is installed as a Flatpak, whose program folder can't be changed. Install Firefox from Mozilla's .tar.bz2 instead (see README)."
  fi
  fail "Firefox not found. Set FIREFOX_ZEN_FIREFOX to its install folder and run this again."
fi

# Profile
profile="${FIREFOX_ZEN_PROFILE:-}"
if [ -z "$profile" ]; then
  profiles=()
  for dir in "$data"/Profiles/*/ "$data"/*/; do
    dir="${dir%/}"
    case "$dir" in *_backup|*/Profiles|*"/Crash Reports"|*"/Pending Pings") continue ;; esac
    [ -f "$dir/prefs.js" ] && profiles+=("$dir")
  done
  [ ${#profiles[@]} -gt 0 ] || fail "No Firefox profile found. Start Firefox once, close it, then run this again."

  # Firefox's default profile (profiles.ini: Install section, else Default=1)
  default=""
  if [ -f "$data/profiles.ini" ]; then
    default="$(awk -F= '/^\[Install/{s=1;next} /^\[/{s=0} s&&$1=="Default"{print $2;exit}' "$data/profiles.ini")"
    [ -n "$default" ] || default="$(awk -F= '/^\[/{p=""} $1=="Path"{p=$2} $1=="Default"&&$2=="1"&&p!=""{print p;exit}' "$data/profiles.ini")"
  fi
  pick=0
  for i in "${!profiles[@]}"; do
    if [ -n "$default" ] && [ "${profiles[$i]##*/}" = "${default##*/}" ]; then pick=$i; fi
  done
  if [ ${#profiles[@]} -gt 1 ]; then
    say "Firefox profiles:"
    for i in "${!profiles[@]}"; do
      mark=""; [ "$i" -eq "$pick" ] && mark="  (default)"
      say "  [$((i + 1))] ${profiles[$i]##*/}$mark"
    done
    answer="$(ask "Install into which profile? [$((pick + 1))] ")" || answer=""
    if [ -n "$answer" ]; then
      case "$answer" in *[!0-9]*) fail "Not a profile number." ;; esac
      [ "$answer" -ge 1 ] && [ "$answer" -le ${#profiles[@]} ] || fail "Not a profile number."
      pick=$((answer - 1))
    fi
  fi
  profile="${profiles[$pick]}"
fi
[ -d "$profile" ] || fail "Profile folder not found: $profile"
chrome="$profile/chrome"
say "Profile: $profile"

# Firefox must be closed (the startup cache is cleared below)
while pgrep -x firefox > /dev/null || pgrep -x firefox-bin > /dev/null; do
  ask "Close Firefox, then press Enter " > /dev/null || fail "Close Firefox, then run this again."
done

# Theme files into <profile>/chrome
installed=0
[ -f "$chrome/JS/firefox-zen-settings.uc.js" ] && installed=1
if [ -e "$chrome" ] && [ $installed -eq 0 ]; then
  backup="$chrome.backup-$(date +%Y%m%d-%H%M%S)"
  mv "$chrome" "$backup"
  say "Moved your old chrome folder to $backup"
fi
if [ $installed -eq 1 ] && [ -d "$chrome/.git" ]; then
  say "Updating with git..."
  git -C "$chrome" pull --ff-only || fail "git pull failed (local changes?). Fix it in the chrome folder and run this again."
elif [ $installed -eq 0 ] && command -v git > /dev/null; then
  say "Downloading with git..."
  git clone --depth 1 "$repo.git" "$chrome" || fail "git clone failed."
else
  say "Downloading..."
  mkdir -p "$chrome"
  curl -fsSL "$repo/archive/refs/heads/main.tar.gz" | tar -xz -C "$chrome" --strip-components 1
fi

# Loader files into the Firefox install folder (only when they changed)
copy=()
for file in config.js defaults/pref/config-prefs.js; do
  cmp -s "$chrome/program/$file" "$ffdir/$file" || copy+=("$file")
done
if [ ${#copy[@]} -gt 0 ]; then
  say "Copying the loader into $ffdir..."
  sudo=""
  if [ ! -w "$ffdir" ] || { [ -d "$ffdir/defaults/pref" ] && [ ! -w "$ffdir/defaults/pref" ]; }; then
    say "(needs admin: sudo may ask for your password)"
    sudo="sudo"
  fi
  for file in "${copy[@]}"; do
    $sudo mkdir -p "$ffdir/$(dirname "$file")"
    $sudo cp "$chrome/program/$file" "$ffdir/$file" ||
      fail "Copying the loader failed. On macOS, allow your terminal under System Settings > Privacy & Security > App Management, then run this again."
  done
fi

# Clear the startup cache so Firefox loads the new scripts
rm -rf "$cache/Profiles/${profile##*/}/startupCache" "$cache/${profile##*/}/startupCache"

say ""
printf '\033[32m%s\033[0m\n' "Firefox-Zen is installed."
say 'Start Firefox and click "Restart now" when Firefox-Zen asks (first start only).'
