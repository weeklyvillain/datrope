#!/bin/sh
# Tests web-publish.sh against temp directories: sh deploy/web-publish.test.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
publish() { DIST="$t/dist" WEB_DIR="$t/web" SWITCH_DIR="$t/switch" DATROPE_BUILD=$1 KEEP=3 sh "$here/web-publish.sh" >/dev/null; }
mkdir -p "$t/dist/assets" "$t/web" "$t/switch"
echo new > "$t/dist/index.html"
echo b > "$t/dist/assets/b.js"

# Fresh install: the defaults point at blue and this build.
publish bbb
[ "$(cat "$t/switch/slot")" = blue ] || fail "slot default"
[ "$(cat "$t/switch/upstream.caddy")" = "reverse_proxy server-blue:8080" ] || fail upstream
[ "$(cat "$t/switch/root.caddy")" = "root * /web/bbb" ] || fail root
[ -f "$t/web/bbb/index.html" ] || fail publish

# The next build keeps the previous build's hashed assets and leaves the switch alone.
echo c > "$t/dist/assets/c.js"
rm "$t/dist/assets/b.js"
sleep 1
publish ccc
[ -f "$t/web/ccc/assets/b.js" ] || fail "old asset merged"
[ -f "$t/web/ccc/assets/c.js" ] || fail "new asset"
[ "$(cat "$t/switch/root.caddy")" = "root * /web/bbb" ] || fail "switch untouched"

# Republishing the live build (a rebuild of the same commit) keeps the assets merged into it.
printf 'root * /web/ccc\n' > "$t/switch/root.caddy"
publish ccc
[ -f "$t/web/ccc/assets/b.js" ] || fail "republish dropped merged assets"

# WEB_SWITCH=1 (a plain docker compose up) points Caddy at the new build; the default leaves it.
DIST="$t/dist" WEB_DIR="$t/web" SWITCH_DIR="$t/switch" DATROPE_BUILD=eee KEEP=3 WEB_SWITCH=1 sh "$here/web-publish.sh" >/dev/null
[ "$(cat "$t/switch/root.caddy")" = "root * /web/eee" ] || fail "WEB_SWITCH=1 did not switch"
[ -f "$t/web/eee/assets/b.js" ] || fail "WEB_SWITCH=1 build lost the live build's assets"
printf 'root * /web/bbb\n' > "$t/switch/root.caddy"
rm -rf "$t/web/eee"

# Bad build names are refused.
if publish "../x" 2>/dev/null; then fail "bad build accepted"; fi

# Prune: keep the 3 newest, never the live one.
for b in d1 d2 d3; do
  sleep 1
  publish $b
done
[ -d "$t/web/bbb" ] || fail "live build pruned"
[ ! -d "$t/web/ccc" ] || fail "old build kept"
[ -d "$t/web/d3" ] || fail "newest pruned"
[ -z "$(ls "$t/web" | grep '\.tmp$' || true)" ] || fail "temp dir left"
echo ok
