# ContextNest Community with Docker Compose

A production setup for one VM with no Kubernetes needed: the Community server, PostgreSQL, and [Caddy](https://caddyserver.com) in front of it for automatic HTTPS. For Kubernetes, use the Helm chart in `deploy/helm/` instead.

## Install

You need a VM with Docker (Compose v2), a DNS name pointing at it, and ports 80 and 443 open (Caddy uses 80 to get the certificate).

```sh
cp .env.example .env
# set CONTEXTNEST_HOST and POSTGRES_PASSWORD (openssl rand -base64 32); SECRETS_KEY is recommended
docker compose up -d
```

Open `https://<CONTEXTNEST_HOST>`. With no license key set, the first visit lands on the License Setup Page; the server runs on the Free tier until a key is installed.

`docker compose ps` shows `community` as `healthy` once `/readyz` passes (database reachable, nest storage writable).

## Configure

Every variable in `.env` is passed to the server, so any setting from `CONFIGURATION.md` can be added there; run `docker compose up -d` to apply it. The bundle sets `DATABASE_URL`, `PUBLIC_BASE_URL` and `TRUSTED_PROXIES` itself.

## Upgrade

```sh
docker compose pull
docker compose up -d
```

Data lives in named volumes (`data` for nest files, `pgdata` for the database), so upgrades keep it. Pin `CONTEXTNEST_VERSION` in `.env` to choose when to move. The first boot after some upgrades runs a pass over every document before it starts answering; the healthcheck allows up to 10 minutes for that.

## Back up

Nest files (the `data` volume) and the database describe each other, so back them up together, with the server stopped so neither changes in between:

```sh
docker compose stop community
docker compose exec -T postgres pg_dump -U contextnest -Fc contextnest > contextnest-$(date +%F).dump
docker run --rm -v contextnest_data:/data -v "$PWD":/backup alpine tar czf /backup/contextnest-data-$(date +%F).tgz -C /data .
docker compose start community
```

Restore is the reverse: `pg_restore --clean` into the `postgres` service, and untar into the `data` volume, both with `community` stopped. Scheduled, online backups are tracked separately.

## Check the bundle

`ci/smoke.sh` builds nothing and needs only Docker: it starts the bundle with `CONTEXTNEST_HOST=localhost` (Caddy issues a local certificate for that name) and waits for `https://localhost/readyz`. CI runs it against an image built from the pull request.
