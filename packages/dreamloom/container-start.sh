#!/bin/sh
# Railway mounts a volume owned by root, and Dreamloom must never run as root: it holds the wallet
# key and handles pictures drawn from a stranger's prompt. So the container starts as root only long
# enough to hand the data folder to the node user, then replaces itself with the server as node.
# RAILWAY_RUN_UID=0 would do the same job by running everything as root, which is why it is never set.
set -eu

# lib/server/env.ts reads DATA_DIR and nothing else, so the folder Railway mounted the volume at is
# passed on as DATA_DIR when that is unset: the folder handed over is always the folder the server
# uses. With neither, the pictures, sessions and daily counters would live inside the image and
# vanish on every deploy, taking the spending caps with them, so the container does not start.
dir="${DATA_DIR:-${RAILWAY_VOLUME_MOUNT_PATH:-}}"
if [ -z "$dir" ]; then
  echo "set DATA_DIR or mount a volume: Dreamloom keeps its pictures and daily counters there" >&2
  exit 1
fi
case "$dir" in
  /?*) ;;
  *)
    echo "the data folder \"$dir\" is not an absolute path below /, so it is not handed to the node user" >&2
    exit 1
    ;;
esac
export DATA_DIR="$dir"
# Next's standalone server listens on HOSTNAME and PORT. The host sets PORT, and Railway's proxy
# reaches the container on its network address, not on loopback.
export HOSTNAME=0.0.0.0

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$dir"
  # The folder only, never recursive: node creates every file in it, and a rename over a file needs
  # the folder's permission, not the file's.
  chown node:node "$dir"
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs -- node packages/dreamloom/server.js
fi

exec node packages/dreamloom/server.js
