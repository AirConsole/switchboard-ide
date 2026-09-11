#!/usr/bin/env bash
#
# The rename switchover, as one command, safe to run from a terminal inside the
# IDE it is restarting.
#
# It is `scripts/deploy.sh` -- build, stop, migrate the state directory, start
# -- with two things added: the checks that only matter while the rename is
# landing, and a detach, so that nothing which happens to the terminal you typed
# it into can interrupt it halfway.
#
# The detach is the point. Running this from inside the IDE means the pane you
# are watching belongs to the server you are about to stop, so:
#
#   - The work runs under `setsid --fork`, reparented to init with no
#     controlling terminal. Killing the pane, closing the browser, or losing the
#     ssh connection cannot reach it: there is no terminal to send SIGHUP to and
#     no process group left to signal. What you see here is a tail of its log,
#     and interrupting the tail interrupts nothing.
#   - A pane would in fact have survived anyway -- tmux owns it, and the
#     server's shutdown only kills its own pty clients (`dispose()` in
#     engine.ts, which never calls `killSession`). The detach is belt and
#     braces, because "the IDE went away mid-migration" is not a thing anyone
#     should have to reason about while it is happening.
#
# What you will see: the browser drops its socket when the server stops and
# reconnects when it comes back, which is every deploy. Your Claude sessions
# keep running throughout -- they are tmux sessions, and the migration moves the
# socket by inode rather than restarting anything.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SWB_PORT:-8084}"
LOG=/tmp/swb-switchover.log
OK=__SWITCHOVER_OK__
FAIL=__SWITCHOVER_FAIL__

# The detached half. Re-entered as a child of init, stdout already redirected to
# the log, so all it does is run the deploy and say how it ended.
if [ "${SWB_SWITCHOVER_CHILD:-}" = 1 ]; then
  cd "$REPO"

  # The rename changed every package name, so the workspace links in
  # node_modules still point at @ide-n-dream/* and pnpm wants to rewrite them
  # before it will build. Detached there is no TTY, and pnpm refuses to touch
  # the modules directory without one rather than prompting into the void:
  # ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, which fails the build. CI=true
  # is pnpm's own documented answer, and it is safe to say yes here because
  # nothing has been stopped yet -- the IDE is still serving while this runs,
  # and a failure costs only the install. Measured: without it the child dies
  # at the build, before the deploy has touched anything.
  echo "switchover: installing (the rename renamed every package)"
  if ! CI=true pnpm install; then
    echo "install failed -- nothing was stopped, the IDE is still up" >&2
    echo "$FAIL"
    exit 0
  fi

  if SWB_PORT="$PORT" "$REPO/scripts/deploy.sh"; then
    echo "$OK"
  else
    echo "deploy failed with status $? -- the server may still be down" >&2
    echo "$FAIL"
  fi
  exit 0
fi

die() { echo "switchover: $*" >&2; exit 1; }

# Worktrees develop, master deploys. Run from a worktree this would build that
# worktree and serve its dist as the live IDE -- and every terminal in the IDE
# is in one, which is exactly where this is meant to be typed, so it has to be
# checked rather than trusted. A linked worktree is the case where these differ.
[ "$(git -C "$REPO" rev-parse --git-dir)" = "$(git -C "$REPO" rev-parse --git-common-dir)" ] ||
  die "$REPO is a linked worktree -- run this from the master checkout"

grep -q '"name": "switchboard"' "$REPO/package.json" ||
  die "the rename is not in this checkout yet -- merge it into master first"

[ -x "$REPO/scripts/deploy.sh" ] || die "scripts/deploy.sh is missing"

echo "switchover: $REPO on $(git -C "$REPO" rev-parse --abbrev-ref HEAD) -> :$PORT"
echo "switchover: detaching; safe to close this pane. Log: $LOG"
echo

: >"$LOG"

# Scrubbed, because this is meant to be run from a terminal inside the IDE and
# that terminal's environment is not yours -- it is the tmux server's, which is
# the environment the *old* IDE server was started with, copied into every pane
# tmux creates. Whatever that server had, you inherit and would hand to the new
# one. Measured, and it is not theoretical: a run from such a pane deployed a
# server that resolved SWB_STATE_DIR back to the old directory it had just
# migrated away from, so it started a second tmux server there and reported
# zero projects. SWB_CLAUDE_CMD is the worse one and the reason this list is not
# just the paths: a scratch instance sets it to `bash` or `vim`, and inheriting
# that into the live IDE makes every new Claude session a plain shell.
#
# The deploy is supposed to resolve all of these itself, so the fix is to let
# it: unset them and keep only the port, which is the one thing the caller may
# legitimately mean.
env -u SWB_STATE_DIR -u SWB_TMUX_SOCKET -u SWB_TMUX_CONF -u SWB_CLAUDE_CMD \
    -u SWB_USAGE_CMD -u SWB_WEB_DIST -u SWB_SHELL \
    -u IDN_STATE_DIR -u IDN_TMUX_SOCKET -u IDN_TMUX_CONF -u IDN_CLAUDE_CMD \
    -u IDN_USAGE_CMD -u IDN_WEB_DIST -u IDN_SHELL -u IDN_PORT \
    SWB_SWITCHOVER_CHILD=1 SWB_PORT="$PORT" setsid --fork "$0" >>"$LOG" 2>&1 </dev/null

# Follow the log until the child says how it ended. Only a view: Ctrl-C here
# leaves the switchover running, which is the whole reason it is detached.
seen=0
for _ in $(seq 1 2000); do   # 2000 * 0.3s, comfortably past a cold build
  total=$(wc -l <"$LOG")
  if [ "$total" -gt "$seen" ]; then
    sed -n "$((seen + 1)),${total}p" "$LOG" | grep -v -e "$OK" -e "$FAIL" || true
    seen=$total
  fi
  if grep -q "$OK" "$LOG"; then echo; echo "switchover: done"; exit 0; fi
  if grep -q "$FAIL" "$LOG"; then echo; die "failed -- see $LOG"; fi
  sleep 0.3
done
die "still running after 10 minutes -- watch it with: tail -f $LOG"
