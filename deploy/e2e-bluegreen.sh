#!/bin/sh
# Zero-downtime update check against a throwaway stack. Needs Linux (the updater needs Linux host
# paths), Docker, git and curl:
#   sh deploy/e2e-bluegreen.sh
# It clones this checkout to a temp dir (origin = itself, main = HEAD), starts the stack there with
# build "one", runs an update through the updater, and checks that no request failed, the new
# build is live, the old slot stopped and an old hashed asset still loads.
#
# Knobs, for machines where 80/443 are taken or the script runs inside a container:
#   BG_TMP       parent of the temp clone (a path the Docker daemon can bind-mount)
#   BG_OVERRIDE  an extra compose file, copied into the clone (e.g. to drop published ports)
#   BG_JOIN=1    connect this container to the stack's network and reach Caddy by name
set -eu
src=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
tmp=$(mktemp -d "${BG_TMP:-/tmp}/bg.XXXXXX")
P=datrope-bg
git clone -q "$src" "$tmp/repo"
git -C "$tmp/repo" checkout -q -B main "$(git -C "$src" rev-parse HEAD)"
git -C "$tmp/repo" remote set-url origin "$tmp/repo"
sha=$(git -C "$tmp/repo" rev-parse HEAD)
# deploy/.env, as on a real install: the updater's compose reads it (compose does not record
# --env-file in its labels).
{ cat "$src/deploy/.env.e2e"; echo "DATROPE_UPDATER_TOKEN=bgtest"; } > "$tmp/repo/deploy/.env"
files="-f docker-compose.yml -f docker-compose.e2e.yml"
if [ -n "${BG_OVERRIDE:-}" ]; then
  cp "$BG_OVERRIDE" "$tmp/repo/deploy/docker-compose.bg.yml"
  files="$files -f docker-compose.bg.yml"
fi
cd "$tmp/repo/deploy"
# The green profile too, so that down also removes the slot the update started.
C="docker compose -p $P $files --profile updater --profile green"
curl_opts="-ksf --max-time 5"
cleanup() {
  [ "${BG_JOIN:-}" = 1 ] && docker network disconnect "${P}_default" "$(hostname)" >/dev/null 2>&1
  $C down -v >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

DATROPE_BUILD=one $C up -d --build --wait server-blue caddy updater
if [ "${BG_JOIN:-}" = 1 ]; then
  docker network connect "${P}_default" "$(hostname)"
  curl_opts="$curl_opts --connect-to localhost:443:caddy:443"
fi
base=https://localhost
get() { curl $curl_opts "$@"; }
get $base/healthz | grep -q '"one"' || fail "build one not live"
old_asset=$(get $base/ | grep -o '/assets/index-[^"]*\.js' | head -n 1)
[ -n "$old_asset" ] || fail "no asset in index.html"

# Hit /healthz through Caddy every 100 ms during the update; count failures.
: > "$tmp/fails"
(
  while [ ! -f "$tmp/stop" ]; do
    get -o /dev/null $base/healthz || echo x >> "$tmp/fails"
    sleep 0.1
  done
) &
loop=$!

$C exec -T updater /updater deploy || fail "deploy failed"

touch "$tmp/stop"
wait $loop
n=$(wc -l < "$tmp/fails")
[ "$n" -eq 0 ] || fail "$n requests failed during the update"
get $base/healthz | grep -q "\"$sha\"" || fail "build $sha not live"
[ -z "$($C ps -q server-blue)" ] || fail "old slot still running"
get -o /dev/null "$base$old_asset" || fail "old asset $old_asset gone"
# LiveKit's webhooks go through Caddy's internal port to the live slot: unsigned, it answers 401.
$C exec -T caddy wget -S -qO- --post-data=x http://localhost:8081/api/voice/webhook 2>&1 | grep -q " 401 " ||
  fail "webhooks do not reach the live server"
echo "ok: updated one -> $sha with no failed requests"
