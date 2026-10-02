#!/bin/sh
# Switchboard, on a machine in the cloud.
#
#   ./provision-gcp.sh create   [name]                   build it, print its URL
#   ./provision-gcp.sh status   <name> --project <id>    what it is, and who touched it
#   ./provision-gcp.sh recreate <name> --project <id>    new VM, same data disk
#   ./provision-gcp.sh destroy  <name> --project <id>    everything it made
#
# POSIX sh, like install.sh, and gcloud is the only thing it needs. The machine
# itself is cloud-config -- the format GCP, Hetzner, DigitalOcean, AWS and a
# local VM all take -- so a second provider needs its own `create` and not a
# second definition of the machine.
#
# **Named for its cloud, because nearly all of it is that cloud's.** The
# network, the firewall, the static address, the snapshot schedule, the audit
# log and even the ssh are gcloud; what is not -- the machine's definition --
# is already in cloud-config.yaml and setup.sh, beside this. A second provider
# is a second script, provision-hetzner.sh next to this one, not a --provider
# flag threaded through every function here. The pieces the two would share
# (the password prompt, the checks on a user name and a domain) move into a
# file of their own when there is a second script to share them with -- and
# not before, since a seam named for a caller that does not exist yet is a
# guess about its shape.
#
# **Not a `swb` verb, and not a pnpm script**, though everything else in this
# repository is one. Those run on the machine the IDE is on; this one runs on
# your laptop, against a machine that does not exist yet, from a checkout
# nobody has installed -- `pnpm install` is several minutes of compiling
# node-pty for a program that only talks to gcloud. `install.sh` is the other
# script with that shape, and for the same reason.
#
# Two things about this script are load-bearing:
#
#   - **It refuses a project inside an organisation** unless told otherwise.
#     Anyone who can administer Compute Engine there can take the machine
#     without the password: set a startup-script and reset it, or snapshot the
#     disk. Encryption keeps the disk unreadable at rest, and cannot keep root
#     out of a machine that is running. The only fix is a project those people
#     do not administer.
#   - **No secret is ever put in instance metadata**, which any project viewer
#     can read. The password travels over the IAP ssh tunnel, once, into a
#     process that turns it into a key and forgets it.
set -eu

DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || DIR=.
ZONE=${SWB_ZONE:-europe-west6-b}
MACHINE=e2-standard-4
DISK_SIZE=100
IMAGE_FAMILY=ubuntu-2404-lts-amd64
IMAGE_PROJECT=ubuntu-os-cloud
PROJECT=""
ASSUME_YES=0
IN_ORG=0
NO_SUDO=0
DELETE_DATA=0
FROM_SNAPSHOT=""
DOMAIN=""
DOMAIN_GIVEN=0
PASSWORD_STDIN=0
USER_FLAG=""
MACHINE_USER=""
MACHINE_UID=""
DOMAIN_ASKED=0
REPO_URL=${SWB_REPO_URL:-https://github.com/AirConsole/switchboard-ide.git}
REPO_REF=${SWB_REPO_REF:-master}

say() { printf '%s\n' "$*"; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# /dev/tty and not stdin, because this is also piped and redirected -- the same
# reason install.sh reads from it. Where there is no terminal at all (CI, a
# hook, a container) that has to be said plainly: the shell's own "cannot open
# /dev/tty" is otherwise the last thing anyone sees.
have_tty() { (: </dev/tty) 2>/dev/null; }

# A question with an answer typed back, on /dev/tty like everything else here,
# so it works under `curl | sh` where stdin is the script.
ask_value() {
  # prompt, default
  if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" >/dev/tty; else printf '%s: ' "$1" >/dev/tty; fi
  read -r reply </dev/tty || reply=""
  [ -n "$reply" ] || reply=$2
  printf '%s' "$reply"
}

ask() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  if ! have_tty; then
    say "No terminal to ask on. Nothing was changed."
    say "  re-run with --yes to proceed without asking."
    exit 1
  fi
  printf '%s [y/N] ' "$1"
  read -r reply </dev/tty || reply=n
  case "$reply" in y|Y|yes|YES) return 0 ;; *) say "Nothing was changed."; exit 1 ;; esac
}

# A Linux user name, and one the image does not already use for something else:
# setup.sh would refuse to take over `syslog` or `ubuntu` -- that would hand the
# person's files to whatever the account was for -- and saying so here, before
# a VM exists, is cheaper than a machine that stops at its first boot.
valid_user() {
  case "$1" in
    ''|*[!a-z0-9_-]*) return 1 ;;
    [!a-z_]*) return 1 ;;
    root|daemon|bin|sys|sync|games|man|lp|mail|news|uucp|proxy|www-data|backup|\
    list|irc|gnats|nobody|ubuntu|admin|syslog|messagebus|sshd|lxd|docker|caddy|\
    _apt|tss|uuidd|tcpdump|landscape|pollinate|polkitd|systemd-*|google-sudoers)
      return 1 ;;
  esac
  [ "${#1}" -le 32 ]
}

# A name, and nothing else. This value is interpolated into a command that runs
# on the machine over ssh, so a quote in it would end the string it sits in --
# the flag is typed by the person who already has ssh, but a typo should not
# become a shell.
# Every resource is `switchboard-<name>-something`, and GCP wants a name that
# starts with a letter, holds only lowercase letters, digits and hyphens, and is
# at most 63 characters. The longest suffix here is `-data`, so 40 leaves room
# for all of them and for anything added later.
valid_name() {
  case "$1" in
    ''|*[!a-z0-9-]*) return 1 ;;
    [!a-z]*|*-) return 1 ;;
  esac
  [ "${#1}" -le 40 ]
}

valid_domain() {
  case "$1" in
    '') return 0 ;;
    *[!A-Za-z0-9.-]*) return 1 ;;
    -*|.*|*-|*.) return 1 ;;
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  # The verbs are the file's own header. Under `curl | sh` there is no file --
  # $0 is the shell's name -- so they are said here instead, rather than
  # `--help` opening with "sed: can't read sh", which is what the README's own
  # one-liner produced.
  if [ -f "$0" ]; then
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  else
    cat <<'EOF'
Switchboard, on a machine in the cloud.

  provision-gcp.sh create   [name]                   build it, print its URL
  provision-gcp.sh status   <name> --project <id>    what it is, and who touched it
  provision-gcp.sh recreate <name> --project <id>    new VM, same data disk
  provision-gcp.sh destroy  <name> --project <id>    everything it made
EOF
  fi
  cat <<'EOF'

Options
  --project <id>      the GCP project (asked for if left out)
  --zone <zone>       default europe-west6-b
  --machine <type>    default e2-standard-4
  --disk-size <GB>    data disk, default 100
  --domain <name>     also answer to this name; it tells you the DNS record
                      (--domain "" takes one away again)
  --user <name>       who the machine is for: your login on it, and /home/<name>
                      (default: your user name here; fixed once the disk exists)
  --password-stdin    read the machine's password from stdin, for scripts;
                      otherwise you are asked for one, or given one
  --repo <url>        which checkout the machine builds from
  --repo-ref <ref>    which branch or tag of it (default master)
  --in-org            a project inside an organisation, without being asked
  --no-sudo           the machine's user gets no sudo
  --from-snapshot <s> recreate: restore the data disk from this snapshot first
  --delete-data       destroy: also delete the data disk and its snapshots
  -y, --yes           do not ask
EOF
}

VERB=${1:-}
[ -n "$VERB" ] || { usage; exit 1; }
case "$VERB" in -h|--help|help) usage; exit 0 ;; esac
shift
# The name is a positional, and optional: with a terminal it is asked for. A
# flag here means it was left out, not that it is called `--project`.
NAME=""
case "${1:-}" in
  ''|-*) : ;;
  *) NAME=$1; shift ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift ;;
    --zone) ZONE=$2; shift ;;
    --machine) MACHINE=$2; shift ;;
    --disk-size) DISK_SIZE=$2; shift ;;
    --domain) DOMAIN=$2; DOMAIN_GIVEN=1; DOMAIN_ASKED=1; shift ;;
    --password-stdin) PASSWORD_STDIN=1 ;;
    --user) USER_FLAG=$2; shift ;;
    --repo) REPO_URL=$2; shift ;;
    --repo-ref) REPO_REF=$2; shift ;;
    --from-snapshot) FROM_SNAPSHOT=$2; shift ;;
    --in-org) IN_ORG=1 ;;
    --no-sudo) NO_SUDO=1 ;;
    --delete-data) DELETE_DATA=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

# Read the piped password **now**, before any other command can touch stdin.
# `gcloud compute ssh` forwards stdin to the far end exactly as ssh does, so the
# first ssh -- the loop that waits for the machine to finish installing --
# swallowed the pipe, and choose_password, reading it minutes later, found
# nothing and quietly made a password up. Measured with a gcloud shim that eats
# stdin the way ssh does: the format step was handed a generated password, and
# `create` printed it as though that were what had been asked for.
PIPED_PASSWORD=""
if [ "$PASSWORD_STDIN" -eq 1 ]; then
  PIPED_PASSWORD=$(cat | tr -d '\n')
  [ -n "$PIPED_PASSWORD" ] || die "--password-stdin: nothing arrived on stdin"
fi

valid_domain "$DOMAIN" || die "--domain takes a name like ide.example.com"
[ -z "$USER_FLAG" ] || valid_user "$USER_FLAG" \
  || die "--user takes a lowercase login name that is not a system account's"
have gcloud || die "gcloud is not on your PATH. https://cloud.google.com/sdk/docs/install"

# Asked once, plainly, because every lookup below hides its own stderr -- and a
# `describe` that fails because the credentials expired is indistinguishable
# from one that fails because the machine is not there. Measured: `status` on a
# running machine said "no machine called dom in n-dream-workspace", which sent
# the reader looking in the wrong place entirely.
gcloud auth print-access-token >/dev/null 2>&1 \
  || die "gcloud has no usable credentials right now -- run:  gcloud auth login"
# What a flag did not say, a terminal is asked for -- which is what keeps the
# published one-liner to `create` and nothing else. With no terminal (CI, a
# hook) each of these is still required, and says so.
if [ -z "$NAME" ]; then
  have_tty || die "which machine? e.g. provision-gcp.sh $VERB mybox --project my-project"
  say ""
  say "A name for this machine. Everything it is made of is called after it:"
  say "the VM, its disk, its network."
  while :; do
    NAME=$(ask_value "  name" "")
    valid_name "$NAME" && break
    say "  letters, digits and hyphens, starting with a letter."
  done
fi
valid_name "$NAME" || die "\"$NAME\" cannot name a machine: letters, digits and hyphens, starting with a letter"

if [ -z "$PROJECT" ]; then
  have_tty || die "--project is required (a project of your own; see --in-org)"
  current=$(gcloud config get-value project 2>/dev/null)
  say ""
  say "The GCP project to build it in. A project of your own is the one that keeps"
  say "other people out of the machine -- see below."
  PROJECT=$(ask_value "  project" "$current")
  [ -n "$PROJECT" ] || die "no project given; nothing was changed"
fi

PASSWORD_MIN=12   # `MIN_LENGTH` in cli/src/password.js; the IDE refuses less
REGION=$(printf '%s' "$ZONE" | sed 's/-[a-z]$//')
VM="switchboard-$NAME"
NET="switchboard-$NAME"
DATA_DISK="switchboard-$NAME-data"
ADDRESS="switchboard-$NAME-ip"
SCHEDULE="switchboard-$NAME-daily"
FW_WEB="switchboard-$NAME-web"
FW_SSH="switchboard-$NAME-ssh"
POLICY_NAME="switchboard-$NAME-touched"

g() { gcloud --project "$PROJECT" "$@"; }
gq() { gcloud --project "$PROJECT" "$@" >/dev/null 2>&1; }




# --- who else can reach this machine ----------------------------------------
# Printed before anything is built, because it is the one thing about a cloud
# machine that no setting on the machine can change.
check_org() {
  parent=$(g projects describe "$PROJECT" --format='value(parent.type)' 2>/dev/null || true)
  [ "$parent" = "organization" ] || return 0

  say ""
  say "This project belongs to an organisation, and these people can take the machine"
  say "without its password -- by setting a startup-script and resetting it, by granting"
  say "themselves admin ssh, or by snapshotting its disk onto a VM of their own:"
  say ""
  me=$(gcloud config get-value account 2>/dev/null)
  g projects get-ancestors-iam-policy "$PROJECT" --flatten='policy.bindings[].members' \
    --format='value(policy.bindings.role,policy.bindings.members)' 2>/dev/null \
    | grep -E 'roles/(owner|editor|compute.admin|compute.instanceAdmin|compute.osAdminLogin|iap.tunnelResourceAccessor)' \
    | grep -v 'serviceAccount' | grep -v "$me" | sed 's/^/  /' | sort -u
  say ""
  say "Encryption keeps the disk unreadable at rest -- snapshots, clones, a stopped VM."
  say "It cannot keep root out of a machine that is running, and nothing can."
  say ""
  # Asked rather than refused, where there is somebody to ask: the answer is a
  # judgement about who those people are, and they are named right above. With
  # no terminal it is still a refusal, because the safe answer cannot be
  # assumed and `--yes` means "do not ask me about the ordinary things".
  if [ "$IN_ORG" -eq 1 ]; then
    ask "Continue anyway?"
    return 0
  fi
  say "A project of your own -- one created under a personal account belongs to no"
  say "organisation -- is the only thing that keeps them out."
  if ! have_tty || [ "$ASSUME_YES" -eq 1 ]; then
    say ""
    say "Nothing was changed. Pass --in-org if that is the trade you want."
    exit 1
  fi
  say ""
  ask "Build it here anyway?"
}

# --- a name for the address --------------------------------------------------
# The machine is reachable by its IP whatever happens; a domain is an addition,
# never a replacement. That is on purpose: the address is the one name that
# cannot be wrong, and it is what you fall back to the day the DNS is.
# Answers yes / no / unknown, and the third is not the second: a machine with
# none of these tools has not told us the name is wrong, and treating it as
# wrong would mean five minutes of dots on every such machine.
#
# Compared field by field with awk rather than grepped: `grep 34.65.1.2` also
# matches 134.65.1.20, and a word-boundary escape that works in GNU grep is not
# the one BSD grep wants.
resolves_to() {
  name=$1; want=$2
  # dig and host first, because they list *every* A record. getent answers with
  # whichever address the resolver felt like returning -- measured:
  # one.one.one.one came back as 1.0.0.1 alone, so a check for 1.1.1.1 said the
  # name pointed somewhere else. It stays as the fallback because a Linux box
  # without bind-utils has nothing else, and a machine has one A record.
  if have dig; then
    dig +short "$name" A 2>/dev/null | awk -v w="$want" '$1 == w { f = 1 } END { exit !f }'
  elif have host; then
    host -t A "$name" 2>/dev/null | awk -v w="$want" '$NF == w { f = 1 } END { exit !f }'
  elif have getent; then
    # `ahostsv4`, not `hosts`: the latter answers with AAAA records where a name
    # has them, and the A record is what is being checked.
    getent ahostsv4 "$name" 2>/dev/null | awk -v w="$want" '$1 == w { f = 1 } END { exit !f }'
  elif have nslookup; then
    nslookup "$name" 2>/dev/null | awk -v w="$want" '$1 == "Address:" && $2 == w { f = 1 } END { exit !f }'
  else
    return 2
  fi
}

# `$?` after an `if` whose condition failed is **zero**, not the condition's
# status -- POSIX says an `if` with no else that does not run its then-branch
# exits 0. So the status is taken in the `else`, where it is still the
# condition's. Read as `$?` after the `fi`, "cannot tell" was indistinguishable
# from "does not resolve".
dns_says() {
  if resolves_to "$1" "$2"; then echo yes; return 0; else rc=$?; fi
  if [ "$rc" -eq 2 ]; then echo unknown; else echo no; fi
}

ask_domain() {
  [ "$DOMAIN_ASKED" -eq 1 ] && return 0
  DOMAIN_ASKED=1
  [ "$ASSUME_YES" -eq 1 ] && return 0
  have_tty || return 0
  say ""
  say "A domain is optional: the machine works at https://$IP either way."
  printf 'Also answer to a domain? Type it, or press enter for none: '
  read -r reply </dev/tty || reply=""
  DOMAIN=$(printf '%s' "$reply" | tr -d ' ')
  valid_domain "$DOMAIN" || die "\"$DOMAIN\" is not a domain name; nothing was changed"
  [ -n "$DOMAIN" ] && DOMAIN_GIVEN=1
  return 0
}

# What to go and do, printed as early as the address exists -- which is before
# the ten minutes the machine spends building itself, so the record has time to
# propagate while you wait rather than after.
say_dns_record() {
  [ -n "$DOMAIN" ] || return 0
  say ""
  say "  Point $DOMAIN at this machine, at whoever runs its DNS:"
  say ""
  say "      type   A"
  say "      name   $DOMAIN"
  say "      value  $IP"
  say ""
  say "  (A record, not CNAME: this is an address, and a CNAME cannot point at one.)"
}

wait_for_dns() {
  [ -n "$DOMAIN" ] || return 0
  case "$(dns_says "$DOMAIN" "$IP")" in
    yes) say "$DOMAIN points here already"; return 0 ;;
    unknown) say "note: nothing on this machine can check DNS; carrying on."; return 0 ;;
  esac
  printf 'waiting for %s to resolve to %s' "$DOMAIN" "$IP"
  i=0
  while [ "$i" -lt 60 ]; do
    if [ "$(dns_says "$DOMAIN" "$IP")" = yes ]; then printf ' ok\n'; return 0; fi
    printf '.'
    sleep 5
    i=$((i + 1))
  done
  printf '\n'
  say "note: $DOMAIN does not point here yet. The machine is set up for it anyway --"
  say "  Caddy gets the certificate on its own once the record exists. Until then,"
  say "  https://$IP works."
}

# Applied over ssh rather than baked into the machine's first boot, so that
# adding, changing or removing a domain later is the same code path as setting
# one up -- `create` again, with a different --domain.
apply_domain() {
  ssh_vm --command "sudo sed -i '/^SWB_DOMAIN=/d' /etc/switchboard/env && \
    printf 'SWB_DOMAIN=%s\\n' '$DOMAIN' | sudo tee -a /etc/switchboard/env >/dev/null && \
    sudo /etc/switchboard/setup.sh >/dev/null 2>&1 && \
    sudo systemctl try-restart switchboard.service" >/dev/null 2>&1 \
    || die "the domain could not be applied; the machine is otherwise fine at https://$IP"
}

# --- the pieces, each looked up before it is made ---------------------------
ensure_network() {
  gq compute networks describe "$NET" || {
    say "network $NET"
    # A dedicated network, because the `default` one carries rules allowing ssh
    # and rdp from the whole internet to everything in it.
    g compute networks create "$NET" --subnet-mode=custom --quiet >/dev/null
    g compute networks subnets create "$NET" --network="$NET" --region="$REGION" \
      --range=10.10.0.0/24 --quiet >/dev/null
  }
  gq compute firewall-rules describe "$FW_WEB" || {
    say "firewall $FW_WEB (80, 443, 8000-8099)"
    g compute firewall-rules create "$FW_WEB" --network="$NET" --direction=INGRESS \
      --action=allow --rules=tcp:80,tcp:443,tcp:8000-8099 --source-ranges=0.0.0.0/0 \
      --target-tags=switchboard --quiet >/dev/null
  }
  gq compute firewall-rules describe "$FW_SSH" || {
    say "firewall $FW_SSH (22, from IAP only)"
    # 35.235.240.0/20 is where `gcloud compute ssh --tunnel-through-iap` comes
    # from. ssh is never on the internet.
    g compute firewall-rules create "$FW_SSH" --network="$NET" --direction=INGRESS \
      --action=allow --rules=tcp:22 --source-ranges=35.235.240.0/20 \
      --target-tags=switchboard --quiet >/dev/null
  }
}

ensure_address() {
  gq compute addresses describe "$ADDRESS" --region="$REGION" || {
    say "static address $ADDRESS"
    g compute addresses create "$ADDRESS" --region="$REGION" --quiet >/dev/null
  }
  IP=$(g compute addresses describe "$ADDRESS" --region="$REGION" --format='value(address)')
}

# --- who the machine is for --------------------------------------------------
# Decided once, when the data disk is made, and kept **on that disk** as a label
# -- never worked out again. The disk is what holds /home/<name>, owned by that
# user; if `recreate` derived the name afresh, a rebuild run from another
# laptop, or by somebody else, would make a user who owns none of the data.
# That is the same kind of mistake the key's salt was, when it lived on the boot
# disk: state a rebuild depends on has to survive the rebuild, and the thing
# that survives it here is the disk.
#
# The uid goes with it, for the same reason: ownership on the volume is a
# number. A disk from before either label existed is `switchboard`, with
# whatever uid it already has, which is what those machines always were.
resolve_user() {
  if gq compute disks describe "$DATA_DISK" --zone="$ZONE"; then
    MACHINE_USER=$(g compute disks describe "$DATA_DISK" --zone="$ZONE" \
      --format='value(labels.switchboard-user)' 2>/dev/null)
    MACHINE_UID=$(g compute disks describe "$DATA_DISK" --zone="$ZONE" \
      --format='value(labels.switchboard-uid)' 2>/dev/null)
    [ -n "$MACHINE_USER" ] || MACHINE_USER=switchboard
    if [ -n "$USER_FLAG" ] && [ "$USER_FLAG" != "$MACHINE_USER" ]; then
      die "this machine's disk belongs to $MACHINE_USER; --user cannot change who a disk is for"
    fi
    return 0
  fi
  if [ -n "$USER_FLAG" ]; then
    MACHINE_USER=$USER_FLAG
  else
    MACHINE_USER=$(id -un 2>/dev/null | tr 'A-Z' 'a-z')
    valid_user "$MACHINE_USER" \
      || die "\"$MACHINE_USER\" cannot be a user on the machine; choose one with --user <name>"
  fi
  MACHINE_UID=2000
}

ensure_data_disk() {
  gq compute disks describe "$DATA_DISK" --zone="$ZONE" || {
    say "data disk $DATA_DISK (${DISK_SIZE}GB)"
    if [ -n "$FROM_SNAPSHOT" ]; then
      g compute disks create "$DATA_DISK" --zone="$ZONE" --source-snapshot="$FROM_SNAPSHOT" \
        --type=pd-balanced --quiet >/dev/null
    else
      g compute disks create "$DATA_DISK" --zone="$ZONE" --size="${DISK_SIZE}GB" \
        --type=pd-balanced --quiet >/dev/null
    fi
  }
  # Written every time, not only on creation: a disk made from a snapshot comes
  # without its labels, and this is what makes the restored machine the same
  # person's again.
  labels="switchboard-user=$MACHINE_USER"
  [ -n "$MACHINE_UID" ] && labels="$labels,switchboard-uid=$MACHINE_UID"
  g compute disks add-labels "$DATA_DISK" --zone="$ZONE" --labels="$labels" --quiet >/dev/null 2>&1 || true
  gq compute resource-policies describe "$SCHEDULE" --region="$REGION" || {
    say "daily snapshots, kept 14 days"
    g compute resource-policies create snapshot-schedule "$SCHEDULE" --region="$REGION" \
      --max-retention-days=14 --daily-schedule --start-time=03:00 \
      --on-source-disk-delete=keep-auto-snapshots --quiet >/dev/null || true
  }
  g compute disks add-resource-policies "$DATA_DISK" --zone="$ZONE" \
    --resource-policies="$SCHEDULE" --quiet >/dev/null 2>&1 || true
}

# The machine is defined by two files next to this one. Under `curl | sh` there
# is no "next to this one" -- $0 is the shell's own name and $DIR is wherever
# you happened to be standing -- so they are fetched, from the same repository
# and ref the machine will build from. In a checkout they are already there and
# nothing is downloaded.
ensure_machine_files() {
  [ -f "$DIR/setup.sh" ] && [ -f "$DIR/cloud-config.yaml" ] && return 0
  have curl || die "this needs curl, or a checkout: git clone $REPO_URL"
  raw=$(printf '%s' "$REPO_URL" | sed 's|^https://github.com/|https://raw.githubusercontent.com/|; s|\.git$||')
  DIR=$(mktemp -d)
  trap 'rm -rf "$DIR"' EXIT INT TERM
  for f in setup.sh cloud-config.yaml; do
    curl -fsSL "$raw/$REPO_REF/cloud/$f" -o "$DIR/$f" \
      || die "could not fetch cloud/$f from $raw/$REPO_REF -- is --repo-ref right?"
    # A 200 with nothing in it is not an error to curl, and an empty setup.sh
    # is a machine that boots into nothing at all.
    [ -s "$DIR/$f" ] || die "cloud/$f came back empty from $raw/$REPO_REF"
  done
}

# cloud-init, with setup.sh carried inside it. One metadata key, no secrets,
# and the machine can be rebuilt from this file alone.
render_user_data() {
  b64=$(base64 -w0 < "$DIR/setup.sh" 2>/dev/null || base64 < "$DIR/setup.sh" | tr -d '\n')
  sed -e "s|PLACEHOLDER_SETUP_B64|$b64|" \
      -e "s|PLACEHOLDER_REPO_URL|$REPO_URL|" \
      -e "s|PLACEHOLDER_REPO_REF|$REPO_REF|" \
      -e "s|PLACEHOLDER_NO_SUDO|$NO_SUDO|" \
      -e "s|PLACEHOLDER_USER|$MACHINE_USER|" \
      -e "s|PLACEHOLDER_UID|$MACHINE_UID|" "$DIR/cloud-config.yaml"
}

ensure_vm() {
  gq compute instances describe "$VM" --zone="$ZONE" && return 0
  say "VM $VM ($MACHINE, $IMAGE_FAMILY)"
  tmp=$(mktemp)
  render_user_data > "$tmp"
  # --no-service-account: agents run arbitrary code here, so the machine holds
  # no credential to the project it sits in. Shielded VM with secure boot, so a
  # boot chain that has been tampered with does not come up quietly.
  g compute instances create "$VM" --zone="$ZONE" --machine-type="$MACHINE" \
    --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
    --boot-disk-size=50GB --boot-disk-type=pd-balanced \
    --subnet="$NET" --address="$IP" --tags=switchboard \
    --disk="name=$DATA_DISK,device-name=switchboard-data,mode=rw,auto-delete=no" \
    --no-service-account --no-scopes \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata-from-file="user-data=$tmp" \
    --metadata=enable-oslogin=TRUE \
    --labels=switchboard="$NAME" --quiet >/dev/null
  rm -f "$tmp"
}

ssh_vm() {
  g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "$@"
}

wait_for() {
  # what, how long, and the command that answers
  what=$1; limit=$2; shift 2
  printf 'waiting for %s' "$what"
  i=0
  while [ "$i" -lt "$limit" ]; do
    if "$@" </dev/null >/dev/null 2>&1; then printf ' ok\n'; return 0; fi
    printf '.'
    sleep 5
    i=$((i + 1))
  done
  printf '\n'
  return 1
}

# --- the password -----------------------------------------------------------
# It is the login *and* the key to the disk, so it is worth choosing rather
# than being handed: a password you picked is one you will still have next
# week, and this is the one secret here that cannot be reset from outside.
#
# **Not a flag.** A value on the command line is in `ps` for every user on your
# machine and in your shell history afterwards, and this one opens a shell on
# the machine it belongs to. Typed here, or piped with --password-stdin, or
# generated -- three ways in, none of which writes it down.
read_secret() {
  # No echo, and restored however this exits -- a terminal left with echo off
  # is a terminal that looks broken.
  printf '%s' "$1" >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true
  trap 'stty echo </dev/tty 2>/dev/null || true' EXIT INT TERM
  read -r secret </dev/tty || secret=""
  stty echo </dev/tty 2>/dev/null || true
  trap - EXIT INT TERM
  printf '\n' >/dev/tty
  printf '%s' "$secret"
}

choose_password() {
  if [ "$PASSWORD_STDIN" -eq 1 ]; then
    PASSWORD=$PIPED_PASSWORD
    CHOSEN=1
  elif have_tty; then
    say ""
    say "A password for this machine. It is the login, and it is the key to the disk --"
    say "nothing else opens either, and it is asked for once per browser."
    while :; do
      PASSWORD=$(read_secret "  password (at least $PASSWORD_MIN characters, enter to have one made): ")
      [ -z "$PASSWORD" ] && break
      if [ "$(printf '%s' "$PASSWORD" | wc -c)" -lt "$PASSWORD_MIN" ]; then
        say "  too short -- this is the whole boundary in front of a program that runs shells."
        continue
      fi
      again=$(read_secret "  again: ")
      [ "$PASSWORD" = "$again" ] && break
      say "  those did not match."
    done
    [ -n "$PASSWORD" ] && CHOSEN=1
  fi

  # Nothing typed and nothing piped: one is made, which is the old behaviour and
  # the right default for a machine built by a script with no terminal.
  if [ -z "${PASSWORD:-}" ]; then
    PASSWORD=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 24)
    CHOSEN=0
  fi

  if [ "$(printf '%s' "$PASSWORD" | wc -c)" -lt "$PASSWORD_MIN" ]; then
    die "that password is shorter than $PASSWORD_MIN characters; nothing was changed"
  fi
}

# --- create ------------------------------------------------------------------
cmd_create() {
  # Before anything is built, so a ref that does not exist costs nothing: the
  # machine's two files are what the VM is made of, and finding out they cannot
  # be fetched after creating a network and a disk is finding out too late.
  ensure_machine_files
  check_org
  # Before anything is built, so a name that cannot be a user costs nothing --
  # it only reads the data disk, if there is one.
  resolve_user
  # Run again on a machine that exists, this updates it -- which is how a
  # domain is added, changed or removed, and the reason `create` has no sibling
  # verb for doing that.
  if gq compute instances describe "$VM" --zone="$ZONE"; then
    EXISTING=1
    say ""
    say "$VM exists; this will update it, not build a second one."
  else
    EXISTING=0
  fi
  [ "$EXISTING" -eq 1 ] || say ""
  [ "$EXISTING" -eq 1 ] || say "About to create, in $PROJECT ($ZONE):"
  if [ "$EXISTING" -eq 0 ]; then
    say "  VM $VM            $MACHINE, Ubuntu 24.04, no service account"
    say "  for               $MACHINE_USER -- your login there, and /home/$MACHINE_USER"
    say "  data disk         ${DISK_SIZE}GB, encrypted, daily snapshots kept 14 days"
    say "  network $NET      80, 443 and 8000-8099 open; ssh only through IAP"
    say "  a static address"
    say ""
    if [ "$MACHINE" = e2-standard-4 ]; then
      say "Roughly \$110-130 a month for the VM and its disks, less if you stop it."
    else
      say "Roughly \$110-130 a month for an e2-standard-4 and its disks; $MACHINE is"
      say "its own price, and stopping it costs less again."
    fi
    say ""
    ask "Create it?"
  fi

  ensure_network
  ensure_address
  ask_domain
  say_dns_record
  ensure_data_disk
  ensure_vm

  wait_for "the machine to finish installing itself (5-10 minutes)" 180 \
    ssh_vm --command 'test -f /opt/switchboard/server/dist/index.js && systemctl is-active switchboard-unlock.service' \
    || die "the machine never finished; look at: gcloud compute ssh $VM --tunnel-through-iap --command 'cloud-init status --long'"

  # The password is generated here and travels once, over the tunnel, into a
  # process that turns it into a key. It is never in metadata, never in a file,
  # and never in this script's own output except at the end, for the human.
  # `format.js` exits 2 on a device that already holds a LUKS volume, and that
  # is the answer to "am I building or updating": it refuses to reformat the
  # disk holding everything you have, so the password and the data below it are
  # left exactly alone and only the domain is applied.
  choose_password
  say "formatting the data volume"
  #
  # `tail` is applied *after*, not in the pipeline: sh has no PIPESTATUS, so
  # `x=$(a | b | tail -1); rc=$?` reports tail's status -- always 0 -- and the
  # refusal above read as an empty answer. Measured: re-running `create` on a
  # machine that exists died with "the volume was not formatted", which is the
  # one thing it had carefully not done.
  set +e
  format_out=$(printf '%s' "$PASSWORD" | ssh_vm --command 'sudo SWB_DATA_DEV=/dev/disk/by-id/google-switchboard-data node /opt/switchboard/cloud/unlock/format.js' 2>/dev/null)
  formatted=$?
  set -e
  RECOVERY=$(printf '%s' "$format_out" | tail -1)
  if [ "$formatted" -eq 2 ]; then
    say "  the volume is already set up; leaving it and the password alone"
    FRESH=0
  elif [ "$formatted" -ne 0 ] || [ -z "$RECOVERY" ]; then
    die "the volume was not formatted; nothing else was changed"
  else
    FRESH=1
  fi

  if [ "$FRESH" -eq 1 ]; then
  # Order matters, and each step needs the one before it:
  #   mount, so the user has a home at all;
  #   unlocked, which makes that home and the IDE's settings in it;
  #   the password, written into that home as the user who owns it -- as root
  #   it would land in root's own state directory, where the IDE never looks;
  #   and only then the IDE, which refuses to start without a password.
  ssh_vm --command 'sudo mount /dev/mapper/switchboard-data /home && sudo systemctl start switchboard-unlocked.service' >/dev/null 2>&1 \
    || die "the volume was formatted but the machine did not come up; ssh in and look at switchboard-unlocked.service"
  printf '%s' "$PASSWORD" | ssh_vm --command "sudo -u $MACHINE_USER env HOME=/home/$MACHINE_USER /opt/switchboard/cli/bin/swb.js password --stdin --reset" >/dev/null 2>&1 \
    || die "the password could not be set; nothing is serving yet"
  ssh_vm --command 'sudo systemctl start switchboard.service' >/dev/null 2>&1 \
    || die "the IDE did not start; ssh in and look at switchboard.service"
  fi

  # Applied whenever --domain was *given* at all, including as "": that is how
  # a domain is taken away again, through the same code path that adds one.
  # Keyed on the flag rather than on "we have asked", which under --yes is true
  # of every machine and would have made each one ssh in to remove a domain it
  # never had.
  if [ -n "$DOMAIN" ]; then
    wait_for_dns
    say "teaching the machine its name"
    apply_domain
  elif [ "$DOMAIN_GIVEN" -eq 1 ]; then
    say "removing any domain this machine had"
    apply_domain
  fi

  wait_for "the IDE" 60 curl -fsS --max-time 5 -o /dev/null "https://$IP/api/health" || \
    say "note: the IDE did not answer yet; it may still be starting"

  say ""
  say "  https://$IP"
  [ -n "$DOMAIN" ] && say "  https://$DOMAIN"
  if [ "$FRESH" -eq 0 ]; then
    say ""
    say "Updated. The password is the one you already have."
    return 0
  fi
  say ""
  if [ "${CHOSEN:-0}" -eq 1 ]; then
    say "  password   the one you chose"
  else
    say "  password   $PASSWORD"
  fi
  say "  recovery   $RECOVERY"
  say ""
  say "The recovery passphrase is shown once and stored nowhere. It opens the disk if"
  say "the password is lost, which nothing else does -- put it in your password"
  say "manager now. The password is the login and the key to the disk alike."
  say ""
  say "Test services: listen on 127.0.0.1:8000-8099 and they are at https://$IP:<port>,"
  say "public, with no password."
}

# What counts as someone else touching this machine, as an audit-log filter.
#
# **By name, never by the VM's instance id**, which is what it was and why it
# missed most of what it was for. Measured against real audit entries:
#   - a snapshot of the data disk is logged against the *disk* (`gce_disk`,
#     `disk_id`) and carries no instance id at all;
#   - the data disk attached to somebody else's VM is logged against *their*
#     VM, and ours appears only in `request.source`;
#   - and `recreate` gives the VM a new instance id, so a filter holding the
#     old one watched a machine that no longer existed.
# Names survive a rebuild and name the disk wherever it turns up. No list of
# methods either: whatever anyone else does to these is worth listing, and a
# list is a guess about which verbs an attacker will use.
#
# A permission change on the project is included because that is how somebody
# gives themselves ssh -- osAdminLogin is granted on the project, not the VM.
# Google's own compute-system account is left out: it is what takes the
# scheduled snapshots, and nobody can act as it. And an operation's closing
# entry is dropped, since a long one is logged when it starts and again when it
# ends -- every snapshot and attach came out twice -- while `operation.last`
# rather than `operation.first` keeps the entries that have no operation at all,
# which a permission change is.
touched_filter() {
  printf '%s' "logName:\"cloudaudit.googleapis.com%2Factivity\" \
AND protoPayload.authenticationInfo.principalEmail!=\"$1\" \
AND NOT protoPayload.authenticationInfo.principalEmail:\"compute-system.iam.gserviceaccount.com\" \
AND NOT operation.last=true \
AND (protoPayload.resourceName=\"projects/$PROJECT/zones/$ZONE/instances/$VM\" \
OR protoPayload.resourceName=\"projects/$PROJECT/zones/$ZONE/disks/$DATA_DISK\" \
OR protoPayload.request.source:\"disks/$DATA_DISK\" \
OR (resource.type=\"project\" AND protoPayload.methodName=\"SetIamPolicy\"))"
}

# --- status ------------------------------------------------------------------
cmd_status() {
  gq compute instances describe "$VM" --zone="$ZONE" || die "no machine called $NAME in $PROJECT"
  IP=$(g compute instances describe "$VM" --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
  state=$(g compute instances describe "$VM" --zone="$ZONE" --format='value(status)')
  say "$VM  $state  https://$IP"
  who=$(g compute disks describe "$DATA_DISK" --zone="$ZONE" \
    --format='value(labels.switchboard-user)' 2>/dev/null || true)
  say "  for ${who:-switchboard}"

  if curl -fsS --max-time 5 -o /dev/null "https://$IP/api/health" 2>/dev/null; then
    say "  unlocked, IDE answering"
  elif curl -fsS --max-time 5 -o /dev/null "https://$IP/" 2>/dev/null; then
    say "  locked -- open https://$IP and enter the password"
  else
    say "  not answering"
  fi

  domain=$(ssh_vm --command 'sed -n "s/^SWB_DOMAIN=//p" /etc/switchboard/env' 2>/dev/null | tr -d "\r" | tail -1)
  if [ -n "${domain:-}" ]; then
    case "$(dns_says "$domain" "$IP")" in
      yes) say "  also https://$domain" ;;
      unknown) say "  also $domain (nothing here can check whether it points at $IP)" ;;
      *) say "  also $domain -- which does NOT point here; add an A record to $IP" ;;
    esac
  fi

  snap=$(g compute snapshots list --filter="sourceDisk~$DATA_DISK" --sort-by=~creationTimestamp \
    --format='value(name,creationTimestamp)' 2>/dev/null | head -1)
  say "  last snapshot: ${snap:-none}"

  # The part nobody can delete out from under you: Admin Activity is immutable
  # and kept 400 days, and this reads it from here rather than from the machine.
  me=$(gcloud config get-value account 2>/dev/null)
  say "  touched by others, last 30 days:"
  g logging read "$(touched_filter "$me")" \
    --freshness=30d --limit=20 \
    --format='value(timestamp,protoPayload.authenticationInfo.principalEmail,protoPayload.methodName,protoPayload.resourceName)' 2>/dev/null \
    | sed 's/^/    /' | grep . || say "    nothing"
}

# --- recreate ----------------------------------------------------------------
# The VM and its boot disk are the disposable half. This is how an OS upgrade
# happens, how a broken machine is fixed, and -- with --from-snapshot -- how a
# backup is restored.
cmd_recreate() {
  ensure_machine_files
  gq compute instances describe "$VM" --zone="$ZONE" || die "no machine called $NAME in $PROJECT"
  # Read off the disk *before* a snapshot restore deletes it: the replacement is
  # made from a snapshot and arrives with no labels, and ensure_data_disk puts
  # these back on it.
  resolve_user
  say "This deletes the VM and its boot disk. The data disk and the address stay."
  [ -n "$FROM_SNAPSHOT" ] && say "The data disk will be REPLACED by snapshot $FROM_SNAPSHOT."
  ask "Recreate $VM?"

  g compute instances delete "$VM" --zone="$ZONE" --quiet >/dev/null
  if [ -n "$FROM_SNAPSHOT" ]; then
    g compute disks delete "$DATA_DISK" --zone="$ZONE" --quiet >/dev/null
  fi
  ensure_network
  ensure_address
  ensure_data_disk
  ensure_vm
  wait_for "the machine to come back" 180 \
    ssh_vm --command 'systemctl is-active switchboard-unlock.service' || true
  say ""
  say "  https://$IP -- enter the password to unlock the disk."
}

# --- destroy -----------------------------------------------------------------
# Everything `create` made, in the order GCP will accept: a network will not go
# while its rules and subnet are there, and a snapshot schedule will not go
# while it is attached to a disk. Then it looks again and says what is left --
# a destroy that half worked should say which half.
cmd_destroy() {
  say "This deletes the VM, its boot disk, the network, the firewall rules and the address."
  if [ "$DELETE_DATA" -eq 1 ]; then
    say ""
    say "--delete-data: the data disk AND its snapshots go too. They are the only"
    say "copy of everything on this machine. This cannot be undone."
    say ""
    # No --yes past this point, on purpose: --yes means "do not ask me about
    # the ordinary things", and deleting the only copy of a machine's data is
    # not one of them. A caller with no terminal is told so rather than given
    # a flag to get around it.
    if ! have_tty; then
      say "Deleting the data disk needs a terminal to confirm on: it is the only copy"
      say "of everything on this machine, and there is no flag for it. Nothing was changed."
      exit 1
    fi
    printf 'Type the machine name to confirm: '
    read -r typed </dev/tty || typed=""
    [ "$typed" = "$NAME" ] || die "that is not the name; nothing was changed"
  else
    say "The data disk and its snapshots are kept (--delete-data removes them)."
    ask "Destroy $VM?"
  fi

  gq compute instances delete "$VM" --zone="$ZONE" --quiet && say "deleted VM"
  g compute disks remove-resource-policies "$DATA_DISK" --zone="$ZONE" \
    --resource-policies="$SCHEDULE" --quiet >/dev/null 2>&1 || true
  gq compute resource-policies delete "$SCHEDULE" --region="$REGION" --quiet && say "deleted snapshot schedule"
  if [ "$DELETE_DATA" -eq 1 ]; then
    gq compute disks delete "$DATA_DISK" --zone="$ZONE" --quiet && say "deleted data disk"
    for s in $(g compute snapshots list --filter="sourceDisk~$DATA_DISK" --format='value(name)' 2>/dev/null); do
      gq compute snapshots delete "$s" --quiet && say "deleted snapshot $s"
    done
  fi
  gq compute firewall-rules delete "$FW_WEB" --quiet && say "deleted firewall $FW_WEB"
  gq compute firewall-rules delete "$FW_SSH" --quiet && say "deleted firewall $FW_SSH"
  gq compute networks subnets delete "$NET" --region="$REGION" --quiet && say "deleted subnet"
  gq compute networks delete "$NET" --quiet && say "deleted network"
  gq compute addresses delete "$ADDRESS" --region="$REGION" --quiet && say "deleted address"
  # There is no alert any more, but a machine built before that change carries
  # one, and destroy is the only thing that would ever take it away.
  for p in $(g alpha monitoring policies list --filter="displayName='$POLICY_NAME'" --format='value(name)' 2>/dev/null); do
    gq alpha monitoring policies delete "$p" --quiet && say "deleted alert policy"
  done

  # Not touched, and said rather than left quiet: both are project-wide and may
  # belong to something else on this project.
  say ""
  say "Left alone: APIs enabled for this machine, and any project-wide audit settings."

  say ""
  say "What is left with this name:"
  left=0
  for r in \
    "instances:compute instances list:--zones=$ZONE" \
    "disks:compute disks list:--zones=$ZONE" \
    "snapshots:compute snapshots list:" \
    "addresses:compute addresses list:--regions=$REGION" \
    "networks:compute networks list:" \
    "firewall-rules:compute firewall-rules list:" \
    "resource-policies:compute resource-policies list:--regions=$REGION"
  do
    kind=${r%%:*}; rest=${r#*:}; sub=${rest%%:*}; extra=${rest#*:}
    # shellcheck disable=SC2086
    found=$(g $sub $extra --filter="name~switchboard-$NAME" --format='value(name)' 2>/dev/null || true)
    if [ -n "$found" ]; then
      left=1
      printf '  %s: %s\n' "$kind" "$(printf '%s' "$found" | tr '\n' ' ')"
    fi
  done
  [ "$left" -eq 0 ] && say "  nothing"
}

case "$VERB" in
  create) cmd_create ;;
  status) cmd_status ;;
  recreate) cmd_recreate ;;
  destroy) cmd_destroy ;;
  *) die "no such command \"$VERB\"" ;;
esac
