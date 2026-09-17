#!/bin/sh
# Install Switchboard on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/AirConsole/switchboard-ide/master/install.sh | sh
#
# It checks what is missing, tells you what it is about to do, and does nothing
# until you say so. Run it with --check to see the report and change nothing.
#
# POSIX sh on purpose: this is the one file that runs before anything is set up,
# on a machine whose bash may be 3.2 (macOS) or absent (some containers).
set -eu

REPO_URL="https://github.com/AirConsole/switchboard-ide.git"
RAW_URL="https://raw.githubusercontent.com/AirConsole/switchboard-ide/master/install.sh"
DIR="${SWB_INSTALL_DIR:-$HOME/src/switchboard-ide}"
ASSUME_YES=0
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    --dir) DIR="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- what this machine is ---------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) say "install.sh: $OS is not supported -- macOS and Linux only."; exit 1 ;;
esac

PM=""
for candidate in brew apt-get dnf pacman zypper apk; do
  if have "$candidate"; then PM="$candidate"; break; fi
done

# --- what is missing --------------------------------------------------------
# Node is checked by *version*, not presence: `engines` wants >= 22 and several
# distributions still ship 18, so "nodejs is installed" is not the question.
NODE_OK=0
NODE_FOUND=""
if have node; then
  NODE_FOUND="$(node -v 2>/dev/null || true)"
  NODE_MAJOR="$(printf '%s' "$NODE_FOUND" | sed 's/^v//; s/\..*//')"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) NODE_OK=0 ;;
    *) [ "$NODE_MAJOR" -ge 22 ] && NODE_OK=1 ;;
  esac
fi

MISSING=""
[ "$NODE_OK" -eq 1 ] || MISSING="$MISSING node"
have git  || MISSING="$MISSING git"
have tmux || MISSING="$MISSING tmux"
have pnpm || MISSING="$MISSING pnpm"
MISSING="${MISSING# }"

say "Switchboard install"
say "  platform   $PLATFORM${PM:+ (}${PM}${PM:+)}"
say "  node       ${NODE_FOUND:-not found}$([ "$NODE_OK" -eq 1 ] && echo '' || echo '   <- needs 22 or newer')"
say "  git        $(have git && echo ok || echo missing)"
say "  tmux       $(have tmux && echo ok || echo 'missing   <- every session lives in one')"
say "  pnpm       $(have pnpm && echo ok || echo missing)"
say "  claude     $(have claude && echo ok || echo 'missing   <- terminals will work, agents will not')"
say "  install to $DIR"
say ""

[ "$CHECK_ONLY" -eq 1 ] && exit 0

# --- say what will happen, then ask -----------------------------------------
if [ -n "$MISSING" ]; then
  if [ -z "$PM" ]; then
    say "Missing:$MISSING -- and no package manager was found to install them with."
    say "Install them yourself and run this again."
    exit 1
  fi
  say "Will install with $PM:$MISSING"
fi
say "Will clone $REPO_URL into $DIR, then build it."
if [ "$ASSUME_YES" -eq 0 ]; then
  # `/dev/tty` and not stdin, because under `curl | sh` stdin is the script.
  # Where there is no terminal to ask on -- CI, a hook, a container -- say so
  # and name the flag, rather than letting the shell's own "cannot open
  # /dev/tty" be the last thing anyone sees.
  if (: < /dev/tty) 2>/dev/null; then
    printf 'Continue? [y/N] '
    read -r reply < /dev/tty || reply=n
  else
    say "No terminal to ask on. Nothing was changed."
    say "  re-run with --yes to proceed without asking:"
    say "    curl -fsSL $RAW_URL | sh -s -- --yes"
    exit 1
  fi
  case "$reply" in y|Y|yes|YES) ;; *) say "Nothing was changed."; exit 1 ;; esac
fi

# --- install what is missing ------------------------------------------------
# pnpm comes from corepack, which ships with node, so it is never a distribution
# package and must be done after node exists.
install_pkgs() {
  pkgs=""
  for want in $MISSING; do
    [ "$want" = pnpm ] && continue
    pkgs="$pkgs $want"
  done
  pkgs="${pkgs# }"
  [ -z "$pkgs" ] && return 0
  case "$PM" in
    brew) brew install $pkgs ;;
    # Not apt's nodejs: Debian 12 ships 18 and this needs 22, so installing it
    # would produce a machine that looks ready and cannot build. Say so instead.
    apt-get)
      for p in $pkgs; do
        if [ "$p" = node ]; then
          say ""
          say "node: your distribution's package is too old for this (needs 22+)."
          say "  use nodesource, nvm, or fnm, then run this again:"
          say "    curl -fsSL https://fnm.vercel.app/install | bash"
          exit 1
        fi
      done
      sudo apt-get update && sudo apt-get install -y $pkgs
      ;;
    dnf)    sudo dnf install -y $pkgs ;;
    pacman) sudo pacman -S --needed $pkgs ;;
    zypper) sudo zypper install -y $pkgs ;;
    apk)    sudo apk add $pkgs ;;
  esac
}
[ -n "$MISSING" ] && install_pkgs

if ! have pnpm; then
  say "enabling pnpm through corepack"
  corepack enable pnpm >/dev/null 2>&1 || npm install -g pnpm
fi

# --- get the source ---------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" pull --ff-only
else
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR"
fi

cd "$DIR"
pnpm install
pnpm build

say ""
say "Installed in $DIR"
say ""
say "  cd $DIR"
say "  pnpm start        # http://127.0.0.1:8084"
say "  pnpm status"
say "  pnpm stop"
say ""
say "Nothing starts it at boot. Settings, if you need them, go in"
say "  ~/.config/switchboard/config.json"
