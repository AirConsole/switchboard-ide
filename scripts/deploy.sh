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

# Whatever this machine's deploy needs that the repository should not know.
#
# `deploy.env` is gitignored: the public name a browser types is a fact about
# one machine, and a default in a shared repository would have every checkout
# announce itself as somebody else's host. Absent, the loopback defaults apply
# and the instance serves this machine only, which is the right answer for a
# checkout nobody has told otherwise.
#
#   # scripts/deploy.env
#   SWB_PUBLIC_HOST=ide.example.com:84
#
[ -f "$REPO/scripts/deploy.env" ] && . "$REPO/scripts/deploy.env"

# A bare name on purpose: the server allows both schemes for it, so nobody
# deploying has to know how the proxy in front is terminating. Getting that
# wrong costs a page that loads over a row that never paints, which is why the
# check at the end of this script exists.
HOST="${SWB_PUBLIC_HOST:-}"

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
(cd server && NODE_ENV=production SWB_PORT="$PORT" \
  setsid --fork node dist/index.js ${HOST:+--host "$HOST"} >>"$LOG" 2>&1 </dev/null)

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "did not come back -- see $LOG" >&2; exit 1; }

# Prove the name is right rather than assume it. `/ws` refuses a page from an
# origin it does not know, and `/api` refuses a Host it does not answer to -- so
# a wrong --host does not fail loudly, it serves a page whose row never paints.
# Check it here, where it is still one edit away from fixed.
for name in ${HOST//,/ }; do
  bare="${name#*://}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $bare" \
    -H 'sec-fetch-site: same-origin' "http://127.0.0.1:$PORT/api/snapshot")
  [ "$code" = "200" ] || { echo "--host looks wrong: /api answered $code for Host: $bare" >&2; exit 1; }
  # A bare name is allowed under both schemes, so checking https is enough.
  origin="$name"; case "$name" in *://*) ;; *) origin="https://$name" ;; esac
  # `skip` rather than `refused` when ws cannot be loaded: a missing module is
  # not evidence the name is wrong, and blocking a deploy on it would be.
  ws=$(node -e '
    let WebSocket
    try { ({ WebSocket } = require("ws")) } catch { console.log("skip"); process.exit(0) }
    const ws = new WebSocket(`ws://127.0.0.1:${process.argv[1]}/ws`, { origin: process.argv[2] })
    let done = false
    const say = (t) => { if (!done) { done = true; console.log(t); process.exit(0) } }
    ws.on("close", (c) => say(c === 1008 ? "refused" : "ok"))
    ws.on("error", () => say("refused"))
    setTimeout(() => say(ws.readyState === WebSocket.OPEN ? "ok" : "refused"), 700)
  ' "$PORT" "$origin" 2>/dev/null || echo skip)
  [ "$ws" != "refused" ] || { echo "--host looks wrong: /ws refused a page from $origin" >&2; exit 1; }
done

if [ -n "$HOST" ]; then
  echo "live on :$PORT at $(git rev-parse --short HEAD), for $HOST"
else
  echo "live on :$PORT at $(git rev-parse --short HEAD), this machine only"
  echo "  (set SWB_PUBLIC_HOST in scripts/deploy.env to serve it through a proxy)"
fi
curl -fsS "http://127.0.0.1:$PORT/api/snapshot" | python3 -c '
import json, sys
s = json.load(sys.stdin)
live = sum(1 for x in s["sessions"] if x["liveness"] == "live")
print("%d of %d sessions live, %d worktrees" % (live, len(s["sessions"]), len(s["worktrees"])))'
