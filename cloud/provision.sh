#!/bin/sh
# Switchboard, on a machine in the cloud.
#
#   ./provision.sh create   <name> --project <id>    build it, print its URL
#   ./provision.sh status   <name> --project <id>    what it is, and who touched it
#   ./provision.sh recreate <name> --project <id>    new VM, same data disk
#   ./provision.sh destroy  <name> --project <id>    everything it made
#
# POSIX sh, like install.sh, and gcloud is the only thing it needs. The machine
# itself is cloud-config -- the format GCP, Hetzner, DigitalOcean, AWS and a
# local VM all take -- so a second provider needs its own `create` and not a
# second definition of the machine.
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

DIR=$(cd "$(dirname "$0")" && pwd)
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
ALERT_EMAIL=""
REPO_URL=${SWB_REPO_URL:-https://github.com/AirConsole/switchboard-ide.git}
REPO_REF=${SWB_REPO_REF:-master}

say() { printf '%s\n' "$*"; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options
  --project <id>      the GCP project (required)
  --zone <zone>       default europe-west6-b
  --machine <type>    default e2-standard-4
  --disk-size <GB>    data disk, default 100
  --alert-email <a>   who to mail when someone else touches the machine
  --repo <url>        which checkout the machine builds from
  --repo-ref <ref>    which branch or tag of it (default master)
  --in-org            allow a project inside an organisation (see above)
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
NAME=${1:-}
case "$NAME" in ""|-*) die "which machine? e.g. provision.sh $VERB mybox --project my-project" ;; esac
shift

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift ;;
    --zone) ZONE=$2; shift ;;
    --machine) MACHINE=$2; shift ;;
    --disk-size) DISK_SIZE=$2; shift ;;
    --alert-email) ALERT_EMAIL=$2; shift ;;
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

have gcloud || die "gcloud is not on your PATH. https://cloud.google.com/sdk/docs/install"
[ -n "$PROJECT" ] || die "--project is required (a project of your own; see --in-org)"

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

ask() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r reply </dev/tty || reply=n
  case "$reply" in y|Y|yes|YES) return 0 ;; *) say "Nothing was changed."; exit 1 ;; esac
}

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
  if [ "$IN_ORG" -eq 0 ]; then
    say "Use a project of your own (one created under a personal account belongs to no"
    say "organisation), or pass --in-org if that is the trade you want."
    exit 1
  fi
  ask "Continue anyway?"
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
  gq compute resource-policies describe "$SCHEDULE" --region="$REGION" || {
    say "daily snapshots, kept 14 days"
    g compute resource-policies create snapshot-schedule "$SCHEDULE" --region="$REGION" \
      --max-retention-days=14 --daily-schedule --start-time=03:00 \
      --on-source-disk-delete=keep-auto-snapshots --quiet >/dev/null || true
  }
  g compute disks add-resource-policies "$DATA_DISK" --zone="$ZONE" \
    --resource-policies="$SCHEDULE" --quiet >/dev/null 2>&1 || true
}

# cloud-init, with setup.sh carried inside it. One metadata key, no secrets,
# and the machine can be rebuilt from this file alone.
render_user_data() {
  b64=$(base64 -w0 < "$DIR/setup.sh" 2>/dev/null || base64 < "$DIR/setup.sh" | tr -d '\n')
  sed -e "s|PLACEHOLDER_SETUP_B64|$b64|" \
      -e "s|PLACEHOLDER_REPO_URL|$REPO_URL|" \
      -e "s|PLACEHOLDER_REPO_REF|$REPO_REF|" \
      -e "s|PLACEHOLDER_NO_SUDO|$NO_SUDO|" "$DIR/cloud-config.yaml"
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

ensure_alert() {
  [ -n "$ALERT_EMAIL" ] || ALERT_EMAIL=$(gcloud config get-value account 2>/dev/null || true)
  [ -n "$ALERT_EMAIL" ] || return 0
  instance_id=$(g compute instances describe "$VM" --zone="$ZONE" --format='value(id)')
  channel=$(g beta monitoring channels list --filter="labels.email_address='$ALERT_EMAIL' AND type='email'" \
    --format='value(name)' 2>/dev/null | head -1)
  if [ -z "$channel" ]; then
    channel=$(g beta monitoring channels create --display-name="Switchboard alerts" \
      --type=email --channel-labels="email_address=$ALERT_EMAIL" --format='value(name)' 2>/dev/null || true)
  fi
  [ -n "$channel" ] || { say "note: could not create a notification channel; skipping the alert"; return 0; }
  g alpha monitoring policies list --filter="displayName='$POLICY_NAME'" --format='value(name)' 2>/dev/null \
    | grep -q . && return 0
  me=$(gcloud config get-value account 2>/dev/null)
  tmp=$(mktemp)
  # Admin Activity logging is always on and cannot be switched off, so a
  # takeover of this VM lands here whatever else happens. The alert is the
  # convenience; `status` reading the same log is the part that cannot be
  # deleted out from under you.
  cat > "$tmp" <<EOF
{
  "displayName": "$POLICY_NAME",
  "combiner": "OR",
  "conditions": [{
    "displayName": "someone else touched $VM",
    "conditionMatchedLog": {
      "filter": "logName:\"cloudaudit.googleapis.com%2Factivity\" AND resource.labels.instance_id=\"$instance_id\" AND protoPayload.authenticationInfo.principalEmail!=\"$me\" AND protoPayload.methodName:(\"instances.setMetadata\" OR \"instances.reset\" OR \"instances.start\" OR \"disks.createSnapshot\" OR \"instances.attachDisk\" OR \"instances.setIamPolicy\")"
    }
  }],
  "alertStrategy": { "notificationRateLimit": { "period": "300s" } },
  "notificationChannels": ["$channel"]
}
EOF
  g alpha monitoring policies create --policy-from-file="$tmp" --quiet >/dev/null 2>&1 \
    && say "alert: mail to $ALERT_EMAIL when anyone else touches $VM" \
    || say "note: the alert could not be created (is the Monitoring API on?); status still reads the log"
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
    if "$@" >/dev/null 2>&1; then printf ' ok\n'; return 0; fi
    printf '.'
    sleep 5
    i=$((i + 1))
  done
  printf '\n'
  return 1
}

# --- create ------------------------------------------------------------------
cmd_create() {
  check_org
  say ""
  say "About to create, in $PROJECT ($ZONE):"
  say "  VM $VM            $MACHINE, Ubuntu 24.04, no service account"
  say "  data disk         ${DISK_SIZE}GB, encrypted, daily snapshots kept 14 days"
  say "  network $NET      80, 443 and 8000-8099 open; ssh only through IAP"
  say "  a static address"
  say ""
  say "Roughly \$110-130 a month for e2-standard-4 plus disks, less if you stop it."
  say ""
  ask "Create it?"

  ensure_network
  ensure_address
  ensure_data_disk
  ensure_vm
  ensure_alert

  wait_for "the machine to finish installing itself (5-10 minutes)" 180 \
    ssh_vm --command 'test -f /opt/switchboard/server/dist/index.js && systemctl is-active switchboard-unlock.service' \
    || die "the machine never finished; look at: gcloud compute ssh $VM --tunnel-through-iap --command 'cloud-init status --long'"

  # The password is generated here and travels once, over the tunnel, into a
  # process that turns it into a key. It is never in metadata, never in a file,
  # and never in this script's own output except at the end, for the human.
  PASSWORD=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 24)
  say "formatting the data volume"
  RECOVERY=$(printf '%s' "$PASSWORD" | ssh_vm --command 'sudo SWB_DATA_DEV=/dev/disk/by-id/google-switchboard-data node /opt/switchboard/cloud/unlock/format.js' 2>/dev/null | tail -1)
  [ -n "$RECOVERY" ] || die "the volume was not formatted; nothing else was changed"

  # Order matters, and each step needs the one before it:
  #   mount, so the user has a home at all;
  #   unlocked, which makes that home and the IDE's settings in it;
  #   the password, written into that home as the user who owns it -- as root
  #   it would land in root's own state directory, where the IDE never looks;
  #   and only then the IDE, which refuses to start without a password.
  ssh_vm --command 'sudo mount /dev/mapper/switchboard-data /home && sudo systemctl start switchboard-unlocked.service' >/dev/null 2>&1 \
    || die "the volume was formatted but the machine did not come up; ssh in and look at switchboard-unlocked.service"
  printf '%s' "$PASSWORD" | ssh_vm --command 'sudo -u switchboard env HOME=/home/switchboard /opt/switchboard/cli/bin/swb.js password --stdin --reset' >/dev/null 2>&1 \
    || die "the password could not be set; nothing is serving yet"
  ssh_vm --command 'sudo systemctl start switchboard.service' >/dev/null 2>&1 \
    || die "the IDE did not start; ssh in and look at switchboard.service"

  wait_for "the IDE" 60 curl -fsS --max-time 5 -o /dev/null "https://$IP/api/health" || \
    say "note: the IDE did not answer yet; it may still be starting"

  say ""
  say "  https://$IP"
  say ""
  say "  password   $PASSWORD"
  say "  recovery   $RECOVERY"
  say ""
  say "Both are shown once and stored nowhere. The password is the login *and* the"
  say "key to the disk; the recovery passphrase opens the disk if the password is"
  say "lost. Put them in your password manager now."
  say ""
  say "Test services: listen on 127.0.0.1:8000-8099 and they are at https://$IP:<port>,"
  say "public, with no password."
}

# --- status ------------------------------------------------------------------
cmd_status() {
  gq compute instances describe "$VM" --zone="$ZONE" || die "no machine called $NAME in $PROJECT"
  IP=$(g compute instances describe "$VM" --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
  state=$(g compute instances describe "$VM" --zone="$ZONE" --format='value(status)')
  say "$VM  $state  https://$IP"

  if curl -fsS --max-time 5 -o /dev/null "https://$IP/api/health" 2>/dev/null; then
    say "  unlocked, IDE answering"
  elif curl -fsS --max-time 5 -o /dev/null "https://$IP/" 2>/dev/null; then
    say "  locked -- open https://$IP and enter the password"
  else
    say "  not answering"
  fi

  snap=$(g compute snapshots list --filter="sourceDisk~$DATA_DISK" --sort-by=~creationTimestamp \
    --format='value(name,creationTimestamp)' 2>/dev/null | head -1)
  say "  last snapshot: ${snap:-none}"

  # The part nobody can delete out from under you: Admin Activity is immutable
  # and kept 400 days, and this reads it from here rather than from the machine.
  me=$(gcloud config get-value account 2>/dev/null)
  say "  touched by others, last 30 days:"
  g logging read \
    "logName:\"cloudaudit.googleapis.com%2Factivity\" AND resource.labels.instance_id=\"$(g compute instances describe "$VM" --zone="$ZONE" --format='value(id)')\" AND protoPayload.authenticationInfo.principalEmail!=\"$me\"" \
    --freshness=30d --limit=20 --format='value(timestamp,protoPayload.authenticationInfo.principalEmail,protoPayload.methodName)' 2>/dev/null \
    | sed 's/^/    /' | grep . || say "    nothing"
}

# --- recreate ----------------------------------------------------------------
# The VM and its boot disk are the disposable half. This is how an OS upgrade
# happens, how a broken machine is fixed, and -- with --from-snapshot -- how a
# backup is restored.
cmd_recreate() {
  gq compute instances describe "$VM" --zone="$ZONE" || die "no machine called $NAME in $PROJECT"
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
