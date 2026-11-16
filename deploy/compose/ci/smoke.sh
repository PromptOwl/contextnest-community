#!/bin/sh
# Smoke test for the compose bundle: start it on localhost (Caddy's own local
# certificate), wait until https://localhost/readyz answers 200 through Caddy,
# then tear it down with its volumes. Run from the repository root.
# CONTEXTNEST_IMAGE / CONTEXTNEST_VERSION pick the image (default: published latest).
set -eu

DIR=deploy/compose
ENV_FILE=$(mktemp)
sed -e 's/^CONTEXTNEST_HOST=.*/CONTEXTNEST_HOST=localhost/' \
    -e 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=smoke-test/' \
    "$DIR/.env.example" > "$ENV_FILE"
cp "$ENV_FILE" "$DIR/.env"
compose() { docker compose -p contextnest-smoke -f "$DIR/compose.yaml" --env-file "$ENV_FILE" "$@"; }
cleanup() { compose down -v >/dev/null 2>&1 || true; rm -f "$DIR/.env" "$ENV_FILE"; }
trap cleanup EXIT

compose config -q
echo "PASS compose config"

compose up -d
for i in $(seq 1 60); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/readyz || true)
  [ "$code" = 200 ] && { echo "PASS https://localhost/readyz 200 (after ~$((i * 5))s)"; exit 0; }
  sleep 5
done
echo "FAIL https://localhost/readyz never answered 200 (last: $code)"
compose ps
compose logs --tail 50
exit 1
