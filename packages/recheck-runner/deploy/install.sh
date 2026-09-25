#!/usr/bin/env bash
#
# Sets up the Moolam re-check runner on a fresh Ubuntu 24.04 machine.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/master/packages/recheck-runner/deploy/install.sh | sudo bash
#
# or, from a checkout:  sudo bash packages/recheck-runner/deploy/install.sh
#
# or, while the repository is private, from a git bundle copied to the machine:
#   git bundle create moolam.bundle master && scp moolam.bundle root@<vm>:/root/moolam.bundle
#   sudo REPO_URL=/root/moolam.bundle bash install.sh
# The bundle becomes the clone's origin, so an update is a new bundle copied over the old one and
# this script run again.
#
# What it does NOT do, because only the operator can: write the secrets into /etc/moolam/runner.env, put
# the CRE session in place, and send the one receiver transaction. The last section prints those
# three steps and the service is left stopped until they are done.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/moolam/moolam.git}"
REPO_REF="${REPO_REF:-master}"
ROOT=/srv/moolam
SERVICE_USER=moolam
STATE_DIR=/var/lib/moolam-recheck-runner
ENV_FILE=/etc/moolam/runner.env

# Both tools run as the service user, which can read every secret on this machine, so each one is
# a fixed release checked against the sha256 its publisher lists. A new version means editing the
# version and its hash together; neither can be changed from the environment.
#
# The CRE CLI: the line for cre_v1.35.0_linux_amd64.tar.gz in the release's own checksums.txt,
# https://github.com/smartcontractkit/cre-cli/releases/download/v1.35.0/checksums.txt, which
# GitHub's own digest for the asset matches.
CRE_VERSION=v1.35.0
CRE_SHA256=11e6d2ecf3292505268442fd55a48c44da2e0b3b1b647a6cee25a67e8965f844
# bun: the lines for bun-linux-x64.zip and bun-linux-x64-baseline.zip in the release's own
# SHASUMS256.txt, https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/SHASUMS256.txt.
# The plain build needs AVX2; the baseline build is bun's own choice for a processor without it.
BUN_VERSION=1.4.2
BUN_SHA256_X64=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
BUN_SHA256_X64_BASELINE=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f

say() { printf '\n== %s\n' "$*"; }

# Downloads over https only and stops the whole install unless the file has exactly this sha256.
fetch_pinned() {
  local url="$1" sha256="$2" file="$3"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$file" "$url"
  if ! printf '%s  %s\n' "$sha256" "$file" | sha256sum --check --strict; then
    echo "the download from $url does not match its pinned sha256, stopping" >&2
    exit 1
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  echo "run this with sudo" >&2
  exit 1
fi

say "packages"
apt-get update -y
apt-get install -y curl git ca-certificates unzip

say "node 22 from NodeSource"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

say "the service user, its state directory and the env file"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -d -m 0755 /etc/moolam
if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
fi
# The runner reads this file as CRE_ENV_FILE and the CRE CLI reads it with -e, both as the service
# user, so the service's group may read it. Root keeps ownership, so that user cannot rewrite its
# own secrets, and nobody else can read it at all.
chown "root:$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"
stat -c '%U:%G %a %n' "$ENV_FILE"

say "bun $BUN_VERSION, from its pinned release archive"
# The workflow folders carry bun.lock, so their dependencies are installed the way they were pinned.
# bun goes in /usr/local/bin, owned by root, which is on the service's PATH and which the service
# user cannot replace. The CRE CLI finds it there when it compiles a workflow.
if grep -qw avx2 /proc/cpuinfo; then
  BUN_BUILD=bun-linux-x64
  BUN_SHA256="$BUN_SHA256_X64"
else
  BUN_BUILD=bun-linux-x64-baseline
  BUN_SHA256="$BUN_SHA256_X64_BASELINE"
fi
TMP="$(mktemp -d)"
fetch_pinned "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_BUILD}.zip" \
  "$BUN_SHA256" "$TMP/bun.zip"
unzip -q "$TMP/bun.zip" -d "$TMP"
install -m 0755 -o root -g root "$TMP/$BUN_BUILD/bun" /usr/local/bin/bun
ln -sf /usr/local/bin/bun /usr/local/bin/bunx
rm -rf "$TMP"
BUN=/usr/local/bin/bun
"$BUN" --version

say "the CRE CLI $CRE_VERSION, from its pinned release archive"
# Ubuntu 24.04 takes the plain archive; 22.04 and older need cre_linux_amd64_ldd2-35.tar.gz, which
# has its own line in the same checksums.txt.
TMP="$(mktemp -d)"
fetch_pinned "https://github.com/smartcontractkit/cre-cli/releases/download/${CRE_VERSION}/cre_linux_amd64.tar.gz" \
  "$CRE_SHA256" "$TMP/cre.tar.gz"
tar -xzf "$TMP/cre.tar.gz" -C "$TMP" "cre_${CRE_VERSION}_linux_amd64"
install -m 0755 -o root -g root "$TMP/cre_${CRE_VERSION}_linux_amd64" /usr/local/bin/cre
rm -rf "$TMP"
cre version || true

say "the repository at $ROOT"
# A bundle is a file on this machine, and a local clone ignores --depth, so it is cloned whole.
# The clone is owned by the service user and git refuses to work in a repository another user owns,
# so root names this one as safe for each command rather than for every repository on the machine.
GIT=(git -c "safe.directory=$ROOT" -C "$ROOT")
if [ -f "$REPO_URL" ]; then
  # verify needs a repository to run in; list-heads does not, and the clone checks the pack itself.
  git bundle list-heads "$REPO_URL" | grep -q " refs/heads/$REPO_REF\$" || {
    echo "$REPO_URL is not a git bundle holding $REPO_REF" >&2
    exit 1
  }
  if [ -d "$ROOT/.git" ]; then
    "${GIT[@]}" remote set-url origin "$REPO_URL"
    "${GIT[@]}" fetch origin "$REPO_REF"
    "${GIT[@]}" checkout -f "origin/$REPO_REF"
  else
    git clone --branch "$REPO_REF" "$REPO_URL" "$ROOT"
  fi
elif [ -d "$ROOT/.git" ]; then
  "${GIT[@]}" fetch --depth 1 origin "$REPO_REF"
  "${GIT[@]}" checkout -f "origin/$REPO_REF"
else
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$ROOT"
fi
"${GIT[@]}" log -1 --format='commit %h, %cs, %s'
chown -R "$SERVICE_USER:$SERVICE_USER" "$ROOT"

say "the workflows' dependencies"
# Both folders, because the runner sends a privately re-checkable passport to the sealed workflow.
for workflow in moolam-verifier moolam-sealed-verifier; do
  su -s /bin/bash "$SERVICE_USER" -c "cd $ROOT/packages/workflow/$workflow && $BUN install --frozen-lockfile"
done

say "building the runner"
# npm ci from the root, scoped to this one workspace, installs exactly what the root lockfile pins
# for it and nothing for the rest of the monorepo, which this machine has no use for. The earlier
# npm install --workspaces=false inside the package folder crashed npm 10 on 2026-09-26 ("Cannot
# read properties of null (reading 'edgesOut')"). The runner itself has no runtime dependencies:
# everything installed here is the compiler and the test runner.
su -s /bin/bash "$SERVICE_USER" -c \
  "cd $ROOT && npm ci --workspace @moolam/recheck-runner --include-workspace-root=false --omit=optional --no-audit --no-fund && cd packages/recheck-runner && npm run build"

say "the systemd unit"
install -m 0644 "$ROOT/packages/recheck-runner/deploy/moolam-recheck-runner.service" \
  /etc/systemd/system/moolam-recheck-runner.service
systemctl daemon-reload
systemctl enable moolam-recheck-runner

cat <<INSTRUCTIONS

== Installed, and deliberately not started.

Three things are the operator's, and only the operator's:

1. The secrets. Copy the template and fill in the five values marked PASTE:
     sudo install -m 0640 -o root -g $SERVICE_USER $ROOT/packages/recheck-runner/deploy/runner.env.example $ENV_FILE
     sudo nano $ENV_FILE
   Leave RUNNER_DRY_RUN=1 until the checks below have run.

2. The CRE session. 'cre workflow simulate' refuses to run without one, proven on 2026-09-22:
   with an empty HOME it answers "Authentication required: not logged in and no CRE_API_KEY set".
   Either copy ~/.cre/cre.yaml from the machine that is already logged in:
     sudo install -d -m 0700 -o $SERVICE_USER -g $SERVICE_USER $STATE_DIR/.cre
     sudo install -m 0600 -o $SERVICE_USER -g $SERVICE_USER ./cre.yaml $STATE_DIR/.cre/cre.yaml
   or, once Chainlink grants deploy access, create an organization API key and add
   CRE_API_KEY to $ENV_FILE instead, which is the version that does not expire on a browser.

3. One receiver transaction from the deployer wallet. See "How the receiver is held during
   judging" in packages/recheck-runner/README.md. Nothing on this machine holds that key and
   nothing here can send it.

Then:
     sudo systemctl start moolam-recheck-runner
     journalctl -u moolam-recheck-runner -f

INSTRUCTIONS
