#!/usr/bin/env bash
#
# Build the master checkout and restart the live instance on :8084.
#
# Run it after merging a branch into master. Worktrees develop, master deploys,
# and this is the deploy.
#
# A failed build stops before the restart: what is running stays running, and
# it is the last thing that built.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SWB_PORT:-8084}"
LOG=/tmp/swb-prod.log

# The origin the browser actually types, which is Caddy's and not ours.
#
# `/ws` refuses a page from any origin it does not know, and behind a proxy this
# process cannot derive the one the page was served from -- it only ever sees
# 127.0.0.1. Unset, the loopback defaults still let a browser on this machine in
# and every socket through Caddy is refused, so this is not optional here.
ORIGIN="${SWB_PUBLIC_ORIGIN:-https://andrin.ide.n-dream.com:84}"

cd "$REPO"

pnpm build

pid="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$pid" ]; then
  echo "stopping $pid"
  kill "$pid"
  # tmux sessions outlive this; only the socket fan-out goes away.
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
fi

# `setsid --fork`, and the --fork is the whole point: plain setsid execs in
# place when it is not already a process-group leader, so node stays a child of
# this script -- bash then waits for it and the deploy never returns. Forking
# reparents the server to init, which is also what stops the terminal that ran
# this from taking the IDE down when it closes.
(cd server && NODE_ENV=production SWB_PORT="$PORT" SWB_PUBLIC_ORIGIN="$ORIGIN" \
  setsid --fork node dist/index.js >>"$LOG" 2>&1 </dev/null)

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "did not come back -- see $LOG" >&2; exit 1; }

echo "live on :$PORT at $(git rev-parse --short HEAD), for $ORIGIN"
curl -fsS "http://127.0.0.1:$PORT/api/snapshot" | python3 -c '
import json, sys
s = json.load(sys.stdin)
live = sum(1 for x in s["sessions"] if x["liveness"] == "live")
print("%d of %d sessions live, %d worktrees" % (live, len(s["sessions"]), len(s["worktrees"])))'
