#!/usr/bin/env bash
#
# One-shot migration from the old name to Switchboard. Run it once, from the
# master checkout, with the server stopped; then deploy.
#
# Nothing is killed. All four identifiers move while the sessions keep running,
# and every claim below was measured on a throwaway tmux server first:
#
#   ~/.config/ide-n-dream -> ~/.config/switchboard
#       The socket lives in here. A unix socket is bound to its *inode*, not to
#       its path, and rename(2) within a filesystem keeps the inode -- so a
#       client that connects to the new path reaches the same listening server,
#       and clients already connected never notice. Measured: pane pid 1211274
#       before the move and after it, `list-sessions` answering on the new path
#       and ENOENT on the old.
#
#   idn-<id> -> swb-<id>
#       Cosmetic. `reconcile()` adopts whatever carries the metadata option and
#       reads the name back off tmux, so nothing matches on the prefix. Renamed
#       anyway, because `tmux ls` is a thing a human reads.
#
#   @idn_meta -> @swb_meta
#       This one *is* load-bearing: it is what marks a session as ours, and the
#       new server adopts nothing without it. Copied, then the old key unset.
#
#   IDN_* -> SWB_*
#       Pure code, nothing persisted. Nothing to do here -- but if you have any
#       of them exported in a shell or a unit file, rename them there too: they
#       are read through `??`, so a stale one goes silently ignored.
#
# The server must be down for the move, because a running one holds `stateFile`
# resolved at import and would write state.json back to the old path.
set -euo pipefail

OLD="$HOME/.config/ide-n-dream"
NEW="$HOME/.config/switchboard"
PORT="${SWB_PORT:-${IDN_PORT:-8084}}"

die() { echo "migrate: $*" >&2; exit 1; }

# Already done is a success, not an error: this script is one-shot and someone
# will run it twice.
if [ ! -e "$OLD" ]; then
  [ -e "$NEW" ] && { echo "already migrated: $NEW"; exit 0; }
  die "neither $OLD nor $NEW exists -- nothing to migrate"
fi
[ -e "$NEW" ] && die "$NEW already exists; move it aside and re-run"

if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  die "something is still listening on :$PORT -- stop the server first"
fi

SOCK_OLD="$OLD/tmux.sock"
SOCK_NEW="$NEW/tmux.sock"
otmux() { tmux -S "$SOCK_OLD" "$@"; }
ntmux() { tmux -S "$SOCK_NEW" "$@"; }

# Recorded before the move and compared after, so "nothing was killed" is
# checked rather than asserted. A pane pid is the process actually running in
# the session -- claude, or your shell.
before=""
if [ -S "$SOCK_OLD" ]; then
  before="$(otmux list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null || true)"
fi
count=$(printf '%s' "$before" | grep -c . || true)
echo "$count session(s) running before the move"

mv "$OLD" "$NEW"
echo "moved $OLD -> $NEW"

if [ -n "$before" ]; then
  [ -S "$SOCK_NEW" ] || die "socket did not come across -- state is at $NEW"
  ntmux list-sessions >/dev/null 2>&1 ||
    die "tmux does not answer on $SOCK_NEW; sessions may still be reachable by inode, do not delete anything"

  # Sorted -u: a session with several panes lists once per pane.
  while read -r name; do
    [ -n "$name" ] || continue
    meta="$(ntmux show-options -t "$name" -qv @idn_meta 2>/dev/null || true)"
    if [ -n "$meta" ]; then
      # Bare name, matching `paneTarget` in tmux.ts: set-option rejects the
      # `=name` form that session-targeting commands accept.
      ntmux set-option -t "$name" @swb_meta "$meta"
      ntmux set-option -t "$name" -u @idn_meta
    else
      echo "  warning: $name carries no @idn_meta -- not ours, left alone" >&2
      continue
    fi
    case "$name" in
      idn-*) ntmux rename-session -t "$name" "swb-${name#idn-}" ;;
    esac
  done < <(printf '%s\n' "$before" | awk '{print $1}' | sort -u)

  after="$(ntmux list-panes -a -F '#{session_name} #{pane_pid}' | awk '{print $2}' | sort)"
  expect="$(printf '%s\n' "$before" | awk '{print $2}' | sort)"
  [ "$after" = "$expect" ] || die "pane pids changed across the move -- expected [$expect], got [$after]"
  echo "$count session(s) still running, same pids, now:"
  ntmux list-sessions -F '  #{session_name}  @swb_meta=#{@swb_meta}' | cut -c1-100
fi

echo
echo "done. Now build and start the new code:  scripts/deploy.sh"
