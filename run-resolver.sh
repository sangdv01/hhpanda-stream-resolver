#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

EPISODE_URL=${1:-https://hhpanda.st/watch-gia-thien/tap-178-sv1.html}

if [ ! -d node_modules/patchright ]; then
  echo "Installing resolver dependencies..." >&2
  npm install
fi

exec node resolve.js "$EPISODE_URL"
