#!/bin/bash
# Everything that could not be done while /home was a locked volume.
#
# Started by the unlock service the moment the mount is there, and ordered on
# it, so nothing here can run against the boot disk by accident -- which is the
# failure that would quietly write a user's home into the clear.
set -euo pipefail

# Who this machine is for; see the same lines in setup.sh.
if [ -f /etc/switchboard/env ]; then
  . /etc/switchboard/env
fi
SWB_USER=${SWB_USER:-switchboard}
HOME_DIR=/home/$SWB_USER
IDE_DIR=/opt/switchboard
IDE_PORT=7999

log() { printf '[unlocked] %s\n' "$*"; }

mountpoint -q /home || { log "/home is not a mount; refusing"; exit 1; }

# A freshly formatted volume is an empty directory, so the user's home is made
# here rather than by useradd -- which ran while this disk was not there.
if [ ! -d "$HOME_DIR" ]; then
  log "first unlock: creating $HOME_DIR"
  mkdir -p "$HOME_DIR"
  cp -a /etc/skel/. "$HOME_DIR/" 2>/dev/null || true
fi

# The files on the volume are owned by a number, and the user this boot made
# has to be that number. setup.sh pins it, so they agree -- but if they ever do
# not (a machine from before the pin, rebuilt on an image whose next free uid
# has moved), the IDE would start as a user who can read none of its own home,
# and what that looks like is every terminal failing for no stated reason.
# Handing the files back is slow on a big home and happens once; not doing it
# is a machine that cannot be used.
owner=$(stat -c %u "$HOME_DIR")
want=$(id -u "$SWB_USER")
if [ "$owner" != "$want" ]; then
  log "$HOME_DIR is owned by uid $owner, not $SWB_USER ($want); handing it back"
  chown -R "$SWB_USER:$SWB_USER" "$HOME_DIR"
fi
chown "$SWB_USER:$SWB_USER" "$HOME_DIR"
chmod 0700 "$HOME_DIR"

IP=$(cat /etc/switchboard/public-ip 2>/dev/null || true)

# The IDE's own settings, written once and then the user's to edit.
#
# The port is pinned rather than left to the default, because Caddy is pointed
# at this exact number and a machine whose proxy and whose server disagree is a
# machine that serves nothing.
#
# `host` is deliberately *not* here: the names this machine answers to change
# when a domain is associated, and they are passed on the command line by the
# unit that starts the IDE (`setup.sh`), which knows them. A copy here would be
# the one that goes stale, and a wrong host is the quiet failure -- the page
# loads, every button works, and the row never paints.
sudo -u "$SWB_USER" mkdir -p "$HOME_DIR/.config/switchboard"
if [ ! -f "$HOME_DIR/.config/switchboard/config.json" ]; then
  sudo -u "$SWB_USER" tee "$HOME_DIR/.config/switchboard/config.json" >/dev/null <<CFG
{
  // Settings for this machine's Switchboard. Comments are allowed here.
  //
  // The port Caddy proxies to. Change it and change /etc/caddy/Caddyfile too.
  "port": $IDE_PORT

  // The names this machine answers to are passed by switchboard.service, from
  // the address and any domain associated with it -- not from here.
}
CFG
  sudo chmod 600 "$HOME_DIR/.config/switchboard/config.json"
fi

# What every agent on this machine reads before it starts.
sudo -u "$SWB_USER" mkdir -p "$HOME_DIR/.claude"
if [ ! -f "$HOME_DIR/.claude/CLAUDE.md" ] && [ -n "$IP" ]; then
  sudo -u "$SWB_USER" tee "$HOME_DIR/.claude/CLAUDE.md" >/dev/null <<MD
# This machine

A cloud machine running the Switchboard IDE. Its data disk is encrypted and
was unlocked with the IDE password; everything under \`/home\` is on it.

## Showing a service you are building

Listen on **127.0.0.1**, on a port between **8000 and 8099**. It is then at
\`https://$IP:<port>\`, over TLS, **public to anyone with the link and with no
password**. Nothing else needs doing -- Caddy already holds those ports.

Do not bind \`0.0.0.0\`: Caddy has the public side of every one of those ports,
so the bind fails with EADDRINUSE. That is the mechanism, not an inconvenience
-- it is what stops a service reaching the internet without going through the
proxy that gives it TLS.

Ports outside 8000-8099 are not reachable from outside at all.

## Credentials

\`gh\` and \`claude\` are logged in as this user. Prefer a fine-grained GitHub
token scoped to the repositories in use: anything on this machine is as
exposed as the machine is.
MD
fi

# Packages an agent installed since the machine was built. apt writes to the
# boot disk, which `provision.sh recreate` throws away, so the list lives on
# the volume and is replayed here. Without this a rebuild silently forgets
# every tool the work depends on -- the same weakness a container has.
PKG_LIST=$HOME_DIR/.switchboard/packages
sudo -u "$SWB_USER" mkdir -p "$HOME_DIR/.switchboard"
if [ -s "$PKG_LIST" ]; then
  missing=()
  while read -r pkg; do
    [ -z "$pkg" ] && continue
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done < "$PKG_LIST"
  if [ ${#missing[@]} -gt 0 ]; then
    log "replaying ${#missing[@]} packages"
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" || log "some packages did not install"
  fi
fi

# Docker keeps its data on the encrypted volume, so it cannot be running
# before this. It is restarted rather than started, because a daemon that came
# up while /home was shut made its data root on the boot disk and the mount
# then hid it -- measured: every `docker run` failed with "no such file or
# directory" on a containers directory that existed, underneath.
install -d -o "$SWB_USER" -g "$SWB_USER" "$HOME_DIR/.docker-data"
systemctl restart docker 2>/dev/null || true

# On a machine being built there is no password yet -- provision.sh sets it
# next, as the user, and starts the IDE itself. The IDE refuses to start
# without one, so starting it here would only be a failed unit for the first
# minute of every machine's life.
if [ -s "$HOME_DIR/.config/switchboard/auth.json" ]; then
  systemctl start switchboard.service
  log "IDE started"
else
  log "no password set yet; leaving the IDE stopped"
fi
