#!/bin/sh
# Install the chart on a kind cluster and prove the basics: the pod becomes
# Ready, /health answers 200, and a nest survives a pod delete. Expects a
# running kind cluster as the current kubectl context, helm, kubectl and curl,
# and IMAGE (repo:tag) already loaded into the cluster (kind load docker-image).
# Run from the repository root. Used by .github/workflows/helm-chart.yml.
set -eu

CHART=deploy/helm/contextnest-community
IMAGE=${IMAGE:?set IMAGE=repository:tag}
REL=cn
SVC=$REL-contextnest-community
PORT=13838

helm install "$REL" "$CHART" \
  --set image.repository="${IMAGE%:*}" --set image.tag="${IMAGE##*:}" \
  --set image.pullPolicy=Never --set config.authMode=open \
  --wait --timeout 5m

pf() {
  kubectl port-forward "svc/$SVC" "$PORT:3838" >/tmp/port-forward.log 2>&1 &
  PF=$!
  i=0
  until curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 30 ] || { cat /tmp/port-forward.log; exit 1; }
    sleep 1
  done
}

pf
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")
[ "$code" = 200 ] || { echo "FAIL /health answered $code"; exit 1; }
echo "PASS /health 200"

[ "$(kubectl exec "deploy/$SVC" -- id -u)" = 1000 ] || { echo "FAIL not uid 1000"; exit 1; }
echo "PASS runs as uid 1000"

curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"name":"Kind Survivor"}' "http://127.0.0.1:$PORT/nests" >/dev/null
echo "PASS nest created"
kill "$PF" 2>/dev/null || true

kubectl delete pod -l "app.kubernetes.io/instance=$REL" --wait=true
kubectl rollout status "deploy/$SVC" --timeout=180s
kubectl wait --for=condition=Ready pod -l "app.kubernetes.io/instance=$REL" --timeout=180s

pf
curl -fsS "http://127.0.0.1:$PORT/nests" | grep -q '"name":"Kind Survivor"' \
  || { echo "FAIL nest lost after pod delete"; exit 1; }
echo "PASS nest survived a pod delete"
kill "$PF" 2>/dev/null || true
