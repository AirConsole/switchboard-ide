#!/usr/bin/env bash
#
# A throwaway ide-n-dream instance, for developing the IDE with the IDE.
#
# It gets its own IDN_STATE_DIR, which means its own state file *and* its own
# tmux socket, so nothing it does can reach the instance you are working in.
# It also builds its own git repositories to have worktrees of, because the
# thing most worth testing is several projects at once.
#
#   scripts/scratch.sh up      # build repos, start the server, print the URL
#   scripts/scratch.sh down    # kill the server, its tmux sessions, its repos
#   CLAUDE_CMD=vim scripts/scratch.sh up
#
# CLAUDE_CMD is what stands in for `claude`. Default `bash`, which is cheap and
# behaves like a terminal. `vim` is the useful one for anything to do with
# attention or resizing: silent at rest, full redraw on SIGWINCH.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${TMPDIR:-/tmp}/idn-scratch"
STATE="$ROOT/state"
PORT="${IDN_SCRATCH_PORT:-8123}"
BASE="http://127.0.0.1:$PORT"

api() { curl -fsS "$BASE$1" "${@:2}"; }

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
    echo "server/dist is missing — run pnpm build first" >&2
    exit 1
  fi
  "$0" down >/dev/null 2>&1 || true
  mkdir -p "$STATE"
  (
    cd "$REPO/server"
    IDN_STATE_DIR="$STATE" IDN_PORT="$PORT" \
      IDN_CLAUDE_CMD="${CLAUDE_CMD:-bash}" NODE_ENV=production \
      nohup node dist/index.js >"$ROOT/server.log" 2>&1 &
  )
  for _ in $(seq 1 40); do
    api /api/health >/dev/null 2>&1 && break
    sleep 0.25
  done
  make_project "$ROOT/one" feature-x fourth two-terms
  make_project "$ROOT/two" alpha
  echo "up on $BASE"
  echo "  projects: one (main + 3 worktrees), two (main + 1)"
  echo "  log:      $ROOT/server.log"
  echo "  tmux:     tmux -S $STATE/tmux.sock ls"
  ;;
down)
  pid=$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
  tmux -S "$STATE/tmux.sock" kill-server 2>/dev/null || true
  sleep 1
  rm -rf "$ROOT"
  echo "down and cleaned"
  ;;
*)
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
