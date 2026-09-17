#!/bin/bash
# Everything that could not be done while /home was a locked volume.
#
# Started by the unlock service the moment the mount is there, and ordered on
# it, so nothing here can run against the boot disk by accident -- which is the
# failure that would quietly write a user's home into the clear.
set -euo pipefail

SWB_USER=switchboard
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
chown "$SWB_USER:$SWB_USER" "$HOME_DIR"
chmod 0700 "$HOME_DIR"

IP=$(cat /etc/switchboard/public-ip 2>/dev/null || true)

# The IDE's own settings. `host` is the name a browser types, which behind
# Caddy this process cannot derive -- unset, every socket through the proxy is
# refused and the row never paints, which is the failure that looks like
# nothing being wrong.
sudo -u "$SWB_USER" mkdir -p "$HOME_DIR/.config/switchboard"
if [ ! -f "$HOME_DIR/.config/switchboard/config.json" ] && [ -n "$IP" ]; then
  printf '{\n  "port": %s,\n  "host": "https://%s"\n}\n' "$IDE_PORT" "$IP" \
    | sudo -u "$SWB_USER" tee "$HOME_DIR/.config/switchboard/config.json" >/dev/null
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

systemctl start docker 2>/dev/null || true

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
