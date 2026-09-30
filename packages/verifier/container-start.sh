#!/bin/sh
# Railway mounts a volume owned by root, and this service must never run as root: safeFetch, sharp
# and the C2PA worker all handle bytes a stranger chose. So the container starts as root only long
# enough to hand the data folder to the node user, then replaces itself with the service as node.
# RAILWAY_RUN_UID=0 would do the same job by running everything as root, which is why it is never set.
set -eu

# The same order src/env.ts reads: DATA_DIR, then the folder Railway mounted the volume at. Only an
# empty value means unset in both places, so the folder handed over is the folder the service uses.
dir="${DATA_DIR:-${RAILWAY_VOLUME_MOUNT_PATH:-}}"

if [ "$(id -u)" = "0" ]; then
  if [ -n "$dir" ]; then
    case "$dir" in
      /?*) ;;
      *)
        echo "the data folder \"$dir\" is not an absolute path below /, so it is not handed to the node user" >&2
        exit 1
        ;;
    esac
    mkdir -p "$dir"
    # The folder only, never recursive: node creates every file in it, and a rename over a file
    # needs the folder's permission, not the file's.
    chown node:node "$dir"
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs -- node packages/verifier/dist/server.js
fi

exec node packages/verifier/dist/server.js
