#!/usr/bin/env bash
#
# A throwaway ide-n-dream instance, for developing the IDE with the IDE.
#
# Every checkout gets its own. The state directory, the tmux socket, the scratch
# repositories and the port are all derived from the path this script lives in,
# so several worktrees can each run one at the same time without reaching each
# other -- or the instance you are working in.
#
# CLAUDE_CMD is what stands in for `claude`. Default `bash`, which is cheap and
# behaves like a terminal. `vim` is the useful one for anything to do with
# attention or resizing: silent at rest, full redraw on SIGWINCH.
set -euo pipefail

usage() {
  cat <<'USAGE'
scratch.sh up      build scratch repos, start the server, print the URL
scratch.sh down    kill the server and its tmux sessions, remove its files
scratch.sh url     print this checkout's URL (the port differs per worktree)
scratch.sh list    every scratch instance on this machine, and whether it lives

  CLAUDE_CMD=vim scratch.sh up    use vim as the stand-in agent
  IDN_SCRATCH_PORT=9000 ...       pin the port instead of deriving one
USAGE
}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One instance per checkout. The slug is there for you to recognise in `list`;
# the hash is what actually keeps two of them apart, since worktrees of
# different projects can share a branch name.
# printf rather than echo: `tr` would turn basename's trailing newline into a
# separator character, and every directory would be named "<slug>-".
SLUG="$(printf '%s' "$(basename "$REPO")" | tr -c 'A-Za-z0-9._-' '-')"
HASH="$(printf '%s' "$REPO" | sha1sum | cut -c1-6)"
ROOT="${TMPDIR:-/tmp}/idn-scratch-$SLUG-$HASH"
STATE="$ROOT/state"
PORTFILE="$ROOT/port"
PIDFILE="$ROOT/server.pid"

# 8200-8499, which is clear of the live instance on 8084 and of Vite on 5240.
# Derived from the same hash, so a checkout keeps its port across restarts --
# an agent that forgets the port can ask for it again and get the same answer --
# and two checkouts start looking from different places.
PORT_SPAN=300
PORT_FLOOR=8200

port_free() { ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }

# Derived first, probed second: the derivation is what makes the port stable and
# collision-unlikely, the probe is what makes it correct when something else got
# there first.
pick_port() {
  local i port
  for i in $(seq 0 $((PORT_SPAN - 1))); do
    port=$((PORT_FLOOR + (16#$HASH + i) % PORT_SPAN))
    if port_free "$port"; then
      echo "$port"
      return 0
    fi
  done
  echo "scratch.sh: no free port in $PORT_FLOOR-$((PORT_FLOOR + PORT_SPAN - 1))" >&2
  return 1
}

stored_port() { cat "$PORTFILE" 2>/dev/null || true; }

api() { curl -fsS "http://127.0.0.1:$PORT$1" "${@:2}"; }

make_project() { # make_project <dir> <branch>...
  local dir="$1"
  shift
  rm -rf "$dir"
  mkdir -p "$dir"
  (
    cd "$dir"
    git init -q -b main
    git config user.email scratch@local
    git config user.name scratch
    echo hello >README.md
    git add -A
    git commit -qm init
  )
  local id
  id=$(api /api/projects -X POST -H 'content-type: application/json' \
    -d "{\"path\":\"$dir\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  for branch in "$@"; do
    api /api/worktrees -X POST -H 'content-type: application/json' \
      -d "{\"projectId\":\"$id\",\"branch\":\"$branch\",\"startClaude\":true}" >/dev/null
  done
}

case "${1:-}" in
up)
  if [ ! -f "$REPO/server/dist/index.js" ]; then
    echo "server/dist is missing -- run pnpm build first" >&2
    exit 1
  fi
  "$0" down >/dev/null 2>&1 || true
  mkdir -p "$STATE"
  PORT="${IDN_SCRATCH_PORT:-$(pick_port)}"
  echo "$PORT" >"$PORTFILE"
  (
    cd "$REPO/server"
    IDN_STATE_DIR="$STATE" IDN_PORT="$PORT" \
      IDN_CLAUDE_CMD="${CLAUDE_CMD:-bash}" NODE_ENV=production \
      nohup node dist/index.js >"$ROOT/server.log" 2>&1 &
    # From inside the subshell, so it is the node process rather than the shell.
    echo $! >"$PIDFILE"
  )
  for _ in $(seq 1 40); do
    api /api/health >/dev/null 2>&1 && break
    sleep 0.25
  done
  if ! api /api/health >/dev/null 2>&1; then
    echo "server did not come up -- see $ROOT/server.log" >&2
    exit 1
  fi
  make_project "$ROOT/one" feature-x fourth two-terms
  make_project "$ROOT/two" alpha
  echo "up on http://127.0.0.1:$PORT"
  echo "  checkout: $REPO"
  echo "  projects: one (main + 3 worktrees), two (main + 1)"
  echo "  log:      $ROOT/server.log"
  echo "  tmux:     tmux -S $STATE/tmux.sock ls"
  ;;
down)
  PORT="$(stored_port)"
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  # The pid file is the reliable handle; the port lookup is the fallback for an
  # instance started before there was one, and it must never kill a process that
  # merely inherited the port after ours died.
  if [ -z "$pid" ] && [ -n "$PORT" ]; then
    pid=$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  fi
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  tmux -S "$STATE/tmux.sock" kill-server 2>/dev/null || true
  sleep 1
  rm -rf "$ROOT"
  echo "down and cleaned${PORT:+ (was :$PORT)}"
  ;;
url)
  PORT="$(stored_port)"
  if [ -z "$PORT" ]; then
    echo "no scratch instance for $REPO -- run scratch.sh up" >&2
    exit 1
  fi
  echo "http://127.0.0.1:$PORT"
  ;;
list)
  shopt -s nullglob
  found=0
  for dir in "${TMPDIR:-/tmp}"/idn-scratch-*/; do
    found=1
    port=$(cat "$dir/port" 2>/dev/null || echo '?')
    pid=$(cat "$dir/server.pid" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      state=running
    else
      # Left behind by a crash or a killed terminal. `down` from that checkout
      # clears it, or just remove the directory.
      state=stale
    fi
    printf '%-46s %-6s %s\n' "$(basename "${dir%/}")" "$port" "$state"
  done
  [ "$found" = 1 ] || echo "no scratch instances"
  ;;
*)
  usage
  exit 1
  ;;
esac
