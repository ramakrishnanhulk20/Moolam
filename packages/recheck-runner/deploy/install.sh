#!/usr/bin/env bash
#
# Sets up the Moolam re-check runner on a fresh Ubuntu 24.04 machine.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/master/packages/recheck-runner/deploy/install.sh | sudo bash
#
# or, from a checkout:  sudo bash packages/recheck-runner/deploy/install.sh
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
CRE_VERSION="${CRE_VERSION:-v1.35.0}"

say() { printf '\n== %s\n' "$*"; }

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
chmod 0600 "$ENV_FILE"

say "bun, for the workflow's own dependencies"
# The workflow folder carries bun.lock, so its dependencies are installed the way they were pinned.
if ! command -v bun >/dev/null 2>&1; then
  su -s /bin/bash "$SERVICE_USER" -c 'curl -fsSL https://bun.sh/install | bash'
fi
BUN="$STATE_DIR/.bun/bin/bun"

say "the CRE CLI $CRE_VERSION"
# Ubuntu 24.04 takes the plain archive; 22.04 and older need cre_linux_amd64_ldd2-35.tar.gz.
if ! command -v cre >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/cre.tar.gz" \
    "https://github.com/smartcontractkit/cre-cli/releases/download/${CRE_VERSION}/cre_linux_amd64.tar.gz"
  tar -xzf "$TMP/cre.tar.gz" -C "$TMP"
  find "$TMP" -maxdepth 2 -type f -name 'cre*linux_amd64' -exec mv {} "$TMP/cre" \;
  [ -f "$TMP/cre" ] || mv "$TMP"/cre_*_linux_amd64 "$TMP/cre"
  chmod +x "$TMP/cre"
  mv "$TMP/cre" /usr/local/bin/cre
  rm -rf "$TMP"
fi
cre version || true

say "the repository at $ROOT"
if [ -d "$ROOT/.git" ]; then
  git -C "$ROOT" fetch --depth 1 origin "$REPO_REF"
  git -C "$ROOT" checkout -f "origin/$REPO_REF"
else
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$ROOT"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$ROOT"

say "the workflow's dependencies"
su -s /bin/bash "$SERVICE_USER" -c "cd $ROOT/packages/workflow/moolam-verifier && $BUN install --frozen-lockfile"

say "building the runner"
# --workspaces=false keeps npm out of the rest of the monorepo, which this machine has no use for,
# and --no-save leaves the committed lockfile alone. The runner itself has no runtime dependencies:
# everything installed here is the compiler and the test runner.
su -s /bin/bash "$SERVICE_USER" -c \
  "cd $ROOT/packages/recheck-runner && npm install --workspaces=false --no-save --omit=optional --no-audit --no-fund && npm run build"

say "the systemd unit"
install -m 0644 "$ROOT/packages/recheck-runner/deploy/moolam-recheck-runner.service" \
  /etc/systemd/system/moolam-recheck-runner.service
systemctl daemon-reload
systemctl enable moolam-recheck-runner

cat <<INSTRUCTIONS

== Installed, and deliberately not started.

Three things are the operator's, and only the operator's:

1. The secrets. Copy the template and fill in the four values marked PASTE:
     sudo cp $ROOT/packages/recheck-runner/deploy/runner.env.example $ENV_FILE
     sudo chmod 0600 $ENV_FILE
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
