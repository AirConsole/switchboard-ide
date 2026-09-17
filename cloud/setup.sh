#!/bin/bash
# What the cloud machine is, as a script rather than as an image.
#
# cloud-init drops this at /etc/switchboard/setup.sh and runs it once; the unit
# it installs runs it again on every boot. It is therefore idempotent
# throughout -- every step asks whether it has already been done. Re-running it
# by hand over ssh is the supported way to debug a machine, which is the whole
# reason the work is here and not in the cloud-config.
#
# Measured on the spike VM (see cloud/README-spike.md for the raw output):
#   - Ubuntu 24.04's GCP image runs cloud-init from the `user-data` metadata
#     key. Debian's images do not ship cloud-init at all.
#   - Caddy VERSION_PLACEHOLDER gets a Let's Encrypt certificate for a bare IP
#     address under the `shortlived` profile. That profile is not optional:
#     Let's Encrypt issues IP certificates under no other one.
#
# Two rules this file exists to keep:
#   - The boot disk holds nothing of the user's. /home is a LUKS volume whose
#     key is derived from the IDE password and never stored anywhere.
#   - Nothing listens on a public address except Caddy. Test services bind
#     loopback and Caddy fronts them, which is also what stops a service
#     reaching the internet without going through it.
set -euo pipefail

IDE_DIR=/opt/switchboard
SWB_USER=switchboard
DATA_DEV=${SWB_DATA_DEV:-/dev/disk/by-id/google-switchboard-data}
MAPPER=switchboard-data
IDE_PORT=7999
UNLOCK_PORT=7998
PORT_LO=8000
PORT_HI=8099
# Written by cloud-init from what `provision.sh` was told. A machine pinned to
# a branch is how this file gets tested before it is the one everybody boots.
[ -f /etc/switchboard/env ] && . /etc/switchboard/env
REPO_URL=${SWB_REPO_URL:-https://github.com/AirConsole/switchboard-ide.git}
REPO_REF=${SWB_REPO_REF:-master}

log() { printf '[setup] %s\n' "$*"; }

# --- who this machine is, from the outside ----------------------------------
# GCP first, then the shape other providers use, then a public echo. The name
# in the certificate and the name the browser types are both this, so a wrong
# answer here is a machine that never gets a certificate.
public_ip() {
  curl -fsS --max-time 3 -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null && return 0
  curl -fsS --max-time 3 'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null && return 0
  curl -fsS --max-time 3 'https://api.ipify.org' 2>/dev/null && return 0
  return 1
}

internal_ip() { hostname -I | awk '{print $1}'; }

IP=$(public_ip) || { log "no public IP; cannot configure TLS"; exit 1; }
INTERNAL_IP=$(internal_ip)
log "public $IP, internal $INTERNAL_IP"

# --- packages ---------------------------------------------------------------
apt_install() {
  local missing=()
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

if ! command -v node >/dev/null || [ "$(node -v | sed 's/^v//; s/\..*//')" -lt 22 ]; then
  log "installing node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
corepack enable pnpm >/dev/null 2>&1 || true

if ! command -v caddy >/dev/null; then
  log "installing caddy"
  curl -1fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt_install caddy
fi

if ! command -v gh >/dev/null; then
  log "installing gh"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt_install gh
fi

if ! command -v docker >/dev/null; then
  log "installing docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# A published port must not escape the machine. Docker installs its own iptables
# rules, so `-p 8042:80` would otherwise be reachable from the internet directly
# -- past Caddy, and past the rule that a test service is only public because
# Caddy chose to front it. `ip` makes `-p` mean loopback, like everything else.
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ] || ! grep -q '"ip"' /etc/docker/daemon.json; then
  printf '{\n  "ip": "127.0.0.1",\n  "data-root": "/home/%s/.docker-data"\n}\n' "$SWB_USER" > /etc/docker/daemon.json
  systemctl restart docker 2>/dev/null || true
fi
# Docker's data root is on the encrypted volume, so it must wait for it.
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/10-switchboard.conf <<'EOF'
[Unit]
RequiresMountsFor=/home
EOF

# --- Caddy -------------------------------------------------------------------
# `default_sni` is load-bearing and looks like a nicety. A browser sends no SNI
# for a bare IP address -- the TLS RFC forbids it -- so without this Caddy finds
# no matching site and answers the handshake with an internal error. Measured on
# the spike: the certificate was obtained fine and *every* connection failed.
#
# The IDE is one site; each test port is its own, bound to the internal address
# so a service can hold the same port number on loopback. Pre-binding all of
# them is what makes a port work the moment something listens, and it is also
# what stops a service publishing itself: 0.0.0.0 is already taken.
render_caddyfile() {
  cat <<EOF
{
  default_sni $IP
  # Declared once, globally, and not per site. Every site here is the same
  # hostname -- the machine's IP, on 101 ports -- and a tls block in each of
  # them is 101 automation policies for one name, which Caddy refuses outright:
  # "hostname appears in more than one automation policy". Measured: the
  # machine came up with no web server at all.
  #
  # The profile is not a preference: Let's Encrypt issues certificates for an
  # IP address under shortlived and under no other. They last six days, which
  # is why nothing here has a renewal cron -- Caddy does it.
  #
  # (No backticks anywhere in this heredoc. It is unquoted, so $IP expands --
  #  and so would a backtick, as a command, while rendering the config.)
  cert_issuer acme {
    profile shortlived
  }
}

https://$IP {
  # While /home is locked the IDE is not running, so the unlock page answers
  # instead. It is a fallback rather than a route, so that unlocking needs no
  # separate URL to remember.
  reverse_proxy 127.0.0.1:$IDE_PORT
  handle_errors {
    @down expression {err.status_code} == 502
    handle @down {
      reverse_proxy 127.0.0.1:$UNLOCK_PORT
    }
  }
}

http://$IP {
  redir https://$IP{uri} permanent
}
EOF
  local port
  for ((port = PORT_LO; port <= PORT_HI; port++)); do
    cat <<EOF

https://$IP:$port {
  bind $INTERNAL_IP
  reverse_proxy 127.0.0.1:$port
}
EOF
  done
} # end render_caddyfile

render_caddyfile > /etc/caddy/Caddyfile.new
if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
else
  rm -f /etc/caddy/Caddyfile.new
fi

# --- hardening --------------------------------------------------------------
# Password SSH and root SSH are off: the only way in is the IAP tunnel with a
# key, and the only way to the data is the IDE password.
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# Swap is zram -- compressed, in RAM. A swapfile on the boot disk would put
# pages of the decrypted volume in the clear on the one disk that is not
# encrypted, which is the whole thing this machine is arranged to avoid.
if ! systemctl is-enabled systemd-zram-setup@zram0.service >/dev/null 2>&1; then
  apt_install systemd-zram-generator
  printf '[zram0]\nzram-size = ram / 2\n' > /etc/systemd/zram-generator.conf
  systemctl daemon-reload
  systemctl start systemd-zram-setup@zram0.service 2>/dev/null || true
fi

# --- the user ---------------------------------------------------------------
# Passwordless sudo, because this is a dev machine and agents install things.
# It costs little: anyone past the IDE password is already this user, and this
# user owns the repos, the Claude credentials and the gh token. The VM holds no
# cloud credentials, and the firewall is enforced outside it.
if ! id "$SWB_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SWB_USER"
fi
if [ "${SWB_NO_SUDO:-0}" = 1 ]; then
  rm -f /etc/sudoers.d/switchboard
else
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$SWB_USER" > /etc/sudoers.d/switchboard
  chmod 0440 /etc/sudoers.d/switchboard
fi
usermod -aG docker "$SWB_USER" 2>/dev/null || true

# --- the IDE, on the boot disk ----------------------------------------------
# In the clear on purpose: it has to be able to run in order to ask for the
# password that decrypts everything else.
if [ ! -d "$IDE_DIR/.git" ]; then
  log "installing the IDE into $IDE_DIR"
  mkdir -p "$IDE_DIR"
  chown "$SWB_USER:$SWB_USER" "$IDE_DIR"
  sudo -u "$SWB_USER" git clone --branch "$REPO_REF" "$REPO_URL" "$IDE_DIR"
  sudo -u "$SWB_USER" bash -lc "cd $IDE_DIR && pnpm install && pnpm build"
fi

if ! command -v claude >/dev/null; then
  log "installing the claude CLI"
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || log "claude install failed; terminals work, agents do not"
fi

# --- what runs later needs to know the machine's name ------------------------
mkdir -p /etc/switchboard
printf '%s\n' "$IP" > /etc/switchboard/public-ip

# Every explicitly installed package, recorded on the *encrypted volume* so a
# rebuilt boot disk can replay it. Post-Invoke rather than a timer: it costs
# nothing, and a list written only periodically is a list that is wrong exactly
# when the machine is rebuilt in a hurry.
cat > /etc/apt/apt.conf.d/99switchboard-packages <<'EOF'
DPkg::Post-Invoke { "if mountpoint -q /home; then install -d -o switchboard -g switchboard /home/switchboard/.switchboard && apt-mark showmanual > /home/switchboard/.switchboard/packages.tmp 2>/dev/null && mv /home/switchboard/.switchboard/packages.tmp /home/switchboard/.switchboard/packages && chown switchboard:switchboard /home/switchboard/.switchboard/packages; fi || true"; };
EOF

# The unlock service and the post-unlock steps are the checkout's, so
# `pnpm pull` updates them like anything else.
if [ -f "$IDE_DIR/cloud/unlocked.sh" ]; then
  install -m 0755 "$IDE_DIR/cloud/unlocked.sh" /etc/switchboard/unlocked.sh
fi
# And so is this file: a machine that has pulled a newer definition uses it on
# the next boot. Copied rather than re-executed -- a setup script that reruns
# itself mid-run is a loop waiting for a bad merge.
if [ -f "$IDE_DIR/cloud/setup.sh" ] && ! cmp -s "$IDE_DIR/cloud/setup.sh" /etc/switchboard/setup.sh; then
  install -m 0755 "$IDE_DIR/cloud/setup.sh" /etc/switchboard/setup.sh
fi

# --- units ------------------------------------------------------------------
cat > /etc/systemd/system/switchboard-setup.service <<EOF
[Unit]
Description=Configure the Switchboard machine
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/etc/switchboard/setup.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/switchboard-unlock.service <<EOF
[Unit]
Description=Unlock the Switchboard data volume
After=network.target

[Service]
ExecStart=/usr/bin/node $IDE_DIR/cloud/unlock/server.js
Restart=always
RestartSec=2
Environment=SWB_UNLOCK_PORT=$UNLOCK_PORT
Environment=SWB_DATA_DEV=$DATA_DEV
Environment=SWB_MAPPER=$MAPPER

[Install]
WantedBy=multi-user.target
EOF

# `pnpm start` detaches and `pnpm stop` stops it, so this is oneshot rather
# than a supervised process: swb goes on owning the process, exactly as on a
# laptop, and `pnpm pull` keeps working. The explicit PATH is the reason
# systemd was avoidable before -- without it the unit cannot find `claude`, and
# terminals work while agents do not.
cat > /etc/systemd/system/switchboard.service <<EOF
[Unit]
Description=Switchboard IDE
After=network.target
RequiresMountsFor=/home

[Service]
Type=oneshot
RemainAfterExit=yes
User=$SWB_USER
WorkingDirectory=$IDE_DIR
Environment=PATH=/home/$SWB_USER/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/pnpm start
ExecStop=/usr/bin/pnpm stop
EOF

# Everything that needs the volume open. Started by the unlock service once the
# mount is there, never enabled -- at boot there is nothing to run it on.
cat > /etc/systemd/system/switchboard-unlocked.service <<EOF
[Unit]
Description=Switchboard: what can only be done once /home is open
RequiresMountsFor=/home

[Service]
Type=oneshot
ExecStart=/etc/switchboard/unlocked.sh
EOF

systemctl daemon-reload
systemctl enable --now switchboard-setup.service >/dev/null 2>&1 || true
systemctl enable --now switchboard-unlock.service

log "done"
