#!/bin/sh
# Chart checks: helm lint, helm template over several value sets, and the
# replica guard. Writes every rendered manifest to $1 (default ./rendered) for
# kubeconform. Run from the repository root. Needs only `helm` and POSIX sh,
# so it runs in the alpine/helm image (see .github/workflows/helm-chart.yml).
set -eu

CHART=deploy/helm/contextnest-community
OUT=${1:-rendered}
mkdir -p "$OUT"
fails=0

ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }

render() { # name, then helm args
  name=$1; shift
  if helm template cn "$CHART" "$@" > "$OUT/$name.yaml" 2> "$OUT/$name.err"; then
    ok "renders: $name"
  else
    bad "renders: $name"; cat "$OUT/$name.err"; return 1
  fi
}

has() { # name, fixed string expected in the render
  if grep -qF -- "$2" "$OUT/$1.yaml"; then ok "$1 has: $2"; else bad "$1 missing: $2"; fi
}

lacks() {
  if grep -qF -- "$2" "$OUT/$1.yaml"; then bad "$1 should not have: $2"; else ok "$1 lacks: $2"; fi
}

refuses() { # name, expected message fragment, then helm args
  name=$1; want=$2; shift 2
  if helm template cn "$CHART" "$@" > /dev/null 2> "$OUT/$name.err"; then
    bad "refuses: $name (it rendered)"
  elif grep -qF -- "$want" "$OUT/$name.err"; then
    ok "refuses: $name"
  else
    bad "refuses: $name (wrong message)"; cat "$OUT/$name.err"
  fi
  rm -f "$OUT/$name.err"
}

if helm lint --strict "$CHART"; then ok "helm lint"; else bad "helm lint"; fi

# Replica guard first: these must fail, and say why.
refuses replicas-sqlite "SQLite can't be shared between pods" --set replicaCount=2
refuses replicas-postgres-rwo "ReadWriteMany" --set replicaCount=2 --set postgres.url=postgres://u:p@db/x
refuses replicas-rwx-sqlite "needs an external Postgres" --set replicaCount=3 --set persistence.accessMode=ReadWriteMany
refuses replicas-no-volume "ReadWriteMany" --set replicaCount=2 --set postgres.url=postgres://u:p@db/x --set persistence.enabled=false --set persistence.accessMode=ReadWriteMany
refuses bad-access-mode "persistence.accessMode must be" --set persistence.accessMode=ReadOnlyMany
refuses url-and-secret "not both" --set postgres.url=postgres://u:p@db/x --set postgres.existingSecret=db
refuses secret-in-configmap "config.env.DATABASE_URL is a secret" --set config.env.DATABASE_URL=postgres://u:p@db/x

# Defaults: one pod, Recreate, PVC, non-root, read-only rootfs, /health probes.
render default
has default "type: Recreate"
has default "replicas: 1"
has default "kind: PersistentVolumeClaim"
has default "runAsNonRoot: true"
has default "fsGroup: 1000"
has default "readOnlyRootFilesystem: true"
has default "path: /health"
has default 'DATA_ROOT: "/data"'
lacks default "kind: Secret"
lacks default "kind: Ingress"
lacks default "DB_DRIVER"

render postgres-url-rwx -f "$CHART/ci/postgres-url-rwx-values.yaml"
has postgres-url-rwx "replicas: 2"
has postgres-url-rwx "type: RollingUpdate"
has postgres-url-rwx "- ReadWriteMany"
has postgres-url-rwx 'DB_DRIVER: "postgres"'
has postgres-url-rwx "DATABASE_URL:"
has postgres-url-rwx 'DB_SSL: "true"'
has postgres-url-rwx 'DRIFT_SCAN_INTERVAL_MS: "0"'

render existing-secrets -f "$CHART/ci/existing-secrets-values.yaml"
has existing-secrets "claimName: contextnest-data"
has existing-secrets "name: contextnest-env"
has existing-secrets "key: url"
lacks existing-secrets "kind: PersistentVolumeClaim"
lacks existing-secrets "kind: Secret"

render discrete-postgres -f "$CHART/ci/discrete-postgres-values.yaml"
has discrete-postgres 'DB_HOST: "postgres.db.svc"'
has discrete-postgres "name: DB_PASSWORD"
has discrete-postgres "PROMPTOWL_KEY:"
has discrete-postgres "OIDC_CLIENT_SECRET:"
lacks discrete-postgres "DATABASE_URL"

render ingress -f "$CHART/ci/ingress-values.yaml"
has ingress "kind: Ingress"
has ingress "secretName: nest-tls"
has ingress "ingressClassName: nginx"
has ingress "kind: ServiceAccount"
has ingress 'TELEMETRY_ENABLED: "true"'

# Existing secrets alone must not leak an inline value into a chart Secret.
render existing-secret-ignores-inline --set existingSecret=env --set secrets.promptowlKey=pk_x
lacks existing-secret-ignores-inline "PROMPTOWL_KEY"

rm -f "$OUT"/*.err
if [ "$fails" -ne 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all chart checks passed"
