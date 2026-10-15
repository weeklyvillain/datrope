#!/bin/sh
# Publishes this web build to the web volume ($WEB_DIR/$DATROPE_BUILD) for Caddy. The updater
# runs it with WEB_SWITCH=0 and switches to the build itself, together with the server
# (deploy/README.md, "How an update runs"). With WEB_SWITCH=1 (a plain docker compose up) it
# points Caddy's root at this build too. On a fresh install it writes all the switch files,
# pointing at the blue slot.
set -eu
DIST=${DIST:-/dist}
WEB_DIR=${WEB_DIR:-/web}
SWITCH_DIR=${SWITCH_DIR:-/switch}
KEEP=${KEEP:-3}
WEB_SWITCH=${WEB_SWITCH:-0}
b=${DATROPE_BUILD:-}
case "$b" in
  '' | *[!0-9A-Za-z._-]* | *..*) echo "bad build: '$b'" >&2; exit 1 ;;
esac

live=""
if [ -f "$SWITCH_DIR/root.caddy" ]; then
  live=$(sed -n 's#^root \* /web/##p' "$SWITCH_DIR/root.caddy")
fi

rm -rf "$WEB_DIR/$b.tmp"
cp -a "$DIST" "$WEB_DIR/$b.tmp"
# Tabs still open on the live build lazy-load its hashed chunks after the switch; a rebuild of
# the same commit keeps what was merged into it before.
mkdir -p "$WEB_DIR/$b.tmp/assets"
for from in "$live" "$b"; do
  [ -n "$from" ] && [ -d "$WEB_DIR/$from/assets" ] || continue
  for f in "$WEB_DIR/$from/assets"/*; do
    [ -e "$f" ] || continue
    [ -e "$WEB_DIR/$b.tmp/assets/${f##*/}" ] || cp -a "$f" "$WEB_DIR/$b.tmp/assets/"
  done
done
rm -rf "$WEB_DIR/$b"
mv "$WEB_DIR/$b.tmp" "$WEB_DIR/$b"
touch "$WEB_DIR/$b"

put() { printf '%s\n' "$2" > "$SWITCH_DIR/$1.tmp" && mv "$SWITCH_DIR/$1.tmp" "$SWITCH_DIR/$1"; }
if [ ! -f "$SWITCH_DIR/slot" ]; then
  put upstream.caddy "reverse_proxy server-blue:8080"
  put root.caddy "root * /web/$b"
  put slot blue
  live=$b
elif [ "$WEB_SWITCH" = 1 ]; then
  put root.caddy "root * /web/$b"
  live=$b
fi

ls -1t "$WEB_DIR" | grep -v '\.tmp$' | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$live" ] || rm -rf "${WEB_DIR:?}/$old"
done
echo "published web build $b"
