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
DIR_GIVEN=0
[ -n "${SWB_INSTALL_DIR:-}" ] && DIR_GIVEN=1
# Run as ./install.sh from inside a checkout, it works on that checkout rather
# than cloning a second one into the default place. Under `curl | sh` there is
# no file, and $0 is the shell's own name. Only a main checkout counts: in a
# linked worktree `.git` is a file, and the clone branch below would then try
# to clone into it.
SELF_WORKTREE=0
case "$0" in
  */install.sh|install.sh)
    SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
    if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/cli/bin/swb.js" ]; then
      if [ -d "$SELF_DIR/.git" ]; then
        [ "$DIR_GIVEN" -eq 0 ] && DIR="$SELF_DIR"
      elif [ -f "$SELF_DIR/.git" ]; then
        SELF_WORKTREE=1
      fi
    fi
    ;;
esac
ASSUME_YES=0
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    --dir) DIR="$2"; DIR_GIVEN=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }

if [ "$SELF_WORKTREE" -eq 1 ] && [ "$DIR_GIVEN" -eq 0 ]; then
  say "install.sh: this is a git worktree. Worktrees develop, the main checkout deploys."
  say "  run it from the main checkout, or name one with --dir"
  exit 1
fi
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
UPDATING=0
[ -d "$DIR/.git" ] && UPDATING=1
if [ "$UPDATING" -eq 1 ]; then
  say "Will update $DIR to the newest version (fast-forward only), then build and restart it."
else
  say "Will clone $REPO_URL into $DIR, build it, ask you for a password and start it."
fi
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
# An update goes through `pnpm pull`, which refuses another branch, local
# changes and a rewritten history with a way out, and restarts on what it
# built -- a bare build here would swap web/dist under a running server that is
# still the old one. A checkout from before `pnpm pull` existed is brought up to
# it by git first.
if [ "$UPDATING" -eq 1 ]; then
  cd "$DIR"
  if [ ! -f cli/src/pull.js ]; then
    git pull --ff-only
    pnpm install
  fi
  if [ -f cli/src/pull.js ]; then
    node cli/bin/swb.js pull
    say ""
    say "Updated $DIR, and restarted on it. From now on: pnpm pull"
    exit 0
  fi
  pnpm build
else
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR"
  cd "$DIR"
  pnpm install
  pnpm build
fi

# --- a settings file to read, with nothing turned on ------------------------
# Written with every setting commented out, which is both the default state and
# the documentation: the alternative is a program whose settings you can only
# find by reading its source. Nothing ever rewrites this file -- it is read and
# never written -- so what is put here stays here.
#
# 0600 because of `token`: it makes this machine readable as somebody else's
# peer, and it is the one secret that would otherwise sit in a world-readable
# file in a home directory.
CONFIG_DIR="${SWB_STATE_DIR:-$HOME/.config/switchboard}"
CONFIG="$CONFIG_DIR/config.json"
if [ ! -e "$CONFIG" ]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG" <<'CONFIG_EOF'
{
  // Settings for this machine's Switchboard. Comments are allowed here, and
  // everything below is commented out -- which is to say, these are the
  // defaults. Uncomment a line to change one.

  // The port the server listens on. It sits just below 8000-8099, which is
  // what a cloud machine publishes for the things you are building, so the
  // IDE and a test service of yours never want the same port.
  // "port": 7999,

  // The public name a browser types, when something proxies to this. Without
  // it every socket arriving through the proxy is refused -- and the failure
  // is quiet: the page loads, every button works, and the row never paints.
  // Write "https://name" to pin the scheme; a bare name allows both.
  // "host": "ide.example.com:83",

  // The address to listen on. Loopback unless another machine has to reach
  // this one directly -- linking it as a peer, over a network you own.
  // "bind": "0.0.0.0",

  // A shared secret letting another Switchboard read this one as a peer
  // without logging in with this machine's password. Rarely needed.
  // "token": ""
}
CONFIG_EOF
  chmod 600 "$CONFIG"
  say ""
  say "Wrote $CONFIG -- every setting, all commented out."
fi

# --- set a password, and start it -------------------------------------------
# The server refuses to start without a password, so an install that stops at
# the build leaves the last two steps as homework -- and the first of them is a
# thing nobody can guess the shape of. `password` asks on /dev/tty itself, which
# is the same terminal this script has already required for its own `Continue?`,
# so it works under `curl | sh`. Where there is none -- `--yes` in CI, a
# container -- it is skipped and the block at the end says what is left to do.
STARTED=0
if node cli/bin/swb.js password --status 2>/dev/null | grep -q '^password set'; then
  say ""
  say "A password is already set on this machine; keeping it."
  STARTED=1
elif (: < /dev/tty) 2>/dev/null; then
  say ""
  say "Set a password. It is asked for once per browser, and it is the whole"
  say "boundary: anyone past it can run commands as you."
  if node cli/bin/swb.js password; then
    STARTED=1
  fi
fi

if [ "$STARTED" -eq 1 ]; then
  say ""
  node cli/bin/swb.js start || STARTED=0
fi

say ""
if [ "$STARTED" -eq 1 ]; then
  say "Switchboard is installed and running."
else
  say "Installed in $DIR. Two commands left:"
  say ""
  say "  cd $DIR"
  say "  pnpm password     # the server will not start without one"
  say "  pnpm start"
fi
say ""
say "  pnpm status       is it up, and what name is it answering to"
say "  pnpm stop         stops the server; the agents keep running in tmux"
say "  pnpm restart      builds, then restarts on what it built"
say "  pnpm pull         update to the newest version and restart on it"
say "  pnpm password     change it; every browser is signed out"
say ""
say "Open it, and open a project -- or clone one first in the terminal the"
say "row ends with, which is a shell on this machine."
say ""
say "It runs until you stop it, and nothing starts it at boot. Settings, if you"
say "need them, go in ~/.config/switchboard/config.json"
