# contextnest-community Helm chart

Runs ContextNest Community Edition on Kubernetes: one Deployment, a Service, a
PersistentVolumeClaim for `/data`, a ConfigMap and (when needed) a Secret, plus
an optional Ingress and ServiceAccount. The image is
`ghcr.io/promptowl/contextnest-community`, published on every release.

## Install

```bash
kubectl create namespace contextnest
kubectl -n contextnest create secret generic contextnest-env \
  --from-literal=PROMPTOWL_KEY=pk_...   # optional: the Free tier runs without one

helm install cn deploy/helm/contextnest-community --namespace contextnest \
  --set config.publicBaseUrl=https://nest.example.com \
  --set existingSecret=contextnest-env

kubectl -n contextnest port-forward svc/cn-contextnest-community 3838:3838
curl http://127.0.0.1:3838/health
```

The chart's `appVersion` is the server release it was written for and is the
default image tag. Set `image.tag` to run another release. Images are published
from the first release that includes this chart: until it ships, install with
an image you built (`docker build .`) and `image.repository`/`image.tag`
pointing at it.

Every server setting is an environment variable, documented in
[CONFIGURATION.md](../../../CONFIGURATION.md). The common ones have values below.
Put any other non-secret setting under `config.env` and any other secret under
`secrets.env` (or in `existingSecret`).

## Storage and replicas

Nest content (markdown and version history) lives as files under `/data`, and so
does the SQLite database unless Postgres is configured. So:

- **Default: one pod.** `replicaCount: 1`, a ReadWriteOnce PVC and the
  `Recreate` strategy, so the old pod stops before the new one opens the volume.
- **More than one pod** needs both an external Postgres (`postgres.*`) and a
  ReadWriteMany volume (`persistence.accessMode: ReadWriteMany`, e.g. NFS,
  EFS, Filestore, Azure Files). The chart refuses to render `replicaCount > 1`
  without both: SQLite can't be shared between pods, and pods on separate
  volumes would each see different nests. With both set, the strategy is
  `RollingUpdate`.
- ReadWriteMany is necessary for several pods, not sufficient: the pods write
  the same nest files concurrently, so the storage needs working POSIX file
  locking and close-to-open consistency (NFSv4 with locking, EFS, Filestore,
  Azure Files over NFS). Storage without file locking (such as Cloud Storage
  FUSE or s3-style FUSE mounts) is single-writer: keep one pod there.
- On network storage set `config.env.DRIFT_SCAN_INTERVAL_MS: "0"`, as the
  periodic scan for external edits is slow there.
- The PVC carries `helm.sh/resource-policy: keep`, so `helm uninstall` leaves
  your nests in place. Delete the PVC yourself to remove them.
- Upgrading from a volume written by the old root image: run
  `chown -R 1000:1000` on it once (the pod's `fsGroup` covers group access on
  most volume types, but not every driver applies it). If it can't write, the
  server refuses to start and logs which path and the `chown` to run (a single
unwritable nest directory is logged as a warning instead).

## Secrets

Values passed with `--set` or a values file are stored in the Helm release
history (a Secret in the release namespace) along with the rest of the values.
For production, create the Secret yourself (or with External Secrets / Sealed
Secrets) and point the chart at it:

```bash
kubectl create secret generic contextnest-env \
  --from-literal=PROMPTOWL_KEY=pk_... --from-literal=SECRETS_KEY="$(openssl rand -hex 32)"
kubectl create secret generic contextnest-db --from-literal=DATABASE_URL=postgres://...
helm install cn deploy/helm/contextnest-community \
  --set existingSecret=contextnest-env --set postgres.existingSecret=contextnest-db
```

`secrets.*`, `postgres.url` and `postgres.password` are fine for trying it out.

A change to the chart's own ConfigMap or Secret rolls the pod (checksum
annotations). A change inside a Secret you manage (`existingSecret`,
`postgres.existingSecret`, `postgres.passwordSecret`) does not: run
`kubectl rollout restart deployment/<release>-contextnest-community`, or set a
`podAnnotations` entry that changes with it (or use a reloader controller).

## Security

The container runs as uid/gid 1000 (`runAsNonRoot`), with a read-only root
filesystem, all capabilities dropped and the RuntimeDefault seccomp profile. The
server writes only to `/data` and to `/tmp`, which is an emptyDir. The
ServiceAccount token isn't mounted, because the server doesn't call the
Kubernetes API.

## Values

| Key | Default | Description |
|---|---|---|
| `replicaCount` | `1` | Pod count. More than 1 needs Postgres and ReadWriteMany persistence (the chart fails otherwise). |
| `image.repository` | `ghcr.io/promptowl/contextnest-community` | Image repository. |
| `image.tag` | `""` | Image tag. Empty = the chart's `appVersion`. |
| `image.pullPolicy` | `IfNotPresent` | Pull policy. |
| `imagePullSecrets` | `[]` | Pull secrets, for a private mirror. |
| `nameOverride` / `fullnameOverride` | `""` | Override resource names. |
| `config.authMode` | `key` | `AUTH_MODE`: `key` (every request authenticated) or `open` (no auth; local/LAN only). |
| `config.publicBaseUrl` | `""` | `PUBLIC_BASE_URL`, the external URL. Set it with OIDC, emailed publish links or citations. |
| `config.trustedProxies` | `private` | `TRUSTED_PROXIES`: peers whose `X-Forwarded-*` headers count. `private` covers an in-cluster ingress controller. |
| `config.nestStorageRoot` | `""` | `NEST_STORAGE_ROOT`. Empty = `/data/nests`. |
| `config.env` | `{}` | Any other non-secret env vars (ConfigMap). Keys the chart sets itself and known secret names are refused. |
| `secrets.promptowlKey` | `""` | `PROMPTOWL_KEY`, the PromptOwl license key. Without one the server runs on the Free tier. |
| `secrets.secretsKey` | `""` | `SECRETS_KEY`, the master key for stored credentials. Don't change it once set. |
| `secrets.env` | `{}` | Any other sensitive env vars, e.g. `OIDC_CLIENT_SECRET`, `SMTP_URL`, `MCP_SIGNING_SECRET`. |
| `existingSecret` | `""` | Existing Secret whose keys are env var names, loaded with `envFrom`. Replaces `secrets.*`. |
| `postgres.url` | `""` | `DATABASE_URL`, stored in the chart's Secret. Selects Postgres. |
| `postgres.existingSecret` | `""` | Existing Secret holding the connection string. Selects Postgres. |
| `postgres.existingSecretKey` | `DATABASE_URL` | Key in `postgres.existingSecret`. |
| `postgres.host` | `""` | `DB_HOST`, for a discrete connection (with `port`, `user`, `database`). Selects Postgres. |
| `postgres.port` | `5432` | `DB_PORT`. |
| `postgres.user` / `postgres.database` | `""` | `DB_USER` / `DB_NAME`. |
| `postgres.password` | `""` | `DB_PASSWORD`, stored in the chart's Secret. |
| `postgres.passwordSecret.name` / `.key` | `""` / `DB_PASSWORD` | Existing Secret for the password (overrides `postgres.password`). |
| `postgres.ssl` | `false` | `DB_SSL`. |
| `postgres.poolMax` | `""` | `DB_POOL_MAX`. Empty = server default (10). |
| `persistence.enabled` | `true` | Mount a PVC at `/data`. Off = emptyDir: nests are lost with the pod. |
| `persistence.existingClaim` | `""` | Use this PVC. Set `accessMode` to its real mode (on install/upgrade the chart also reads the claim and refuses `replicaCount > 1` unless it is ReadWriteMany). |
| `persistence.storageClass` | `""` | StorageClass. Empty = cluster default; `-` = none. |
| `persistence.accessMode` | `ReadWriteOnce` | `ReadWriteOnce`, `ReadWriteOncePod` or `ReadWriteMany`. |
| `persistence.size` | `10Gi` | Requested size. |
| `persistence.annotations` | `{}` | PVC annotations. |
| `service.type` | `ClusterIP` | Service type. |
| `service.port` | `3838` | Service port (the container always listens on 3838). |
| `service.annotations` | `{}` | Service annotations. |
| `ingress.enabled` | `false` | Create an Ingress. |
| `ingress.className` | `""` | `ingressClassName`. |
| `ingress.annotations` | `{}` | Ingress annotations. MCP streams: with ingress-nginx, turn proxy buffering off. |
| `ingress.hosts` | `contextnest.example.com`, path `/` | Hosts and paths. |
| `ingress.tls` | `[]` | TLS entries (`secretName`, `hosts`). |
| `serviceAccount.create` | `false` | Create a ServiceAccount (for cloud workload identity). |
| `serviceAccount.name` | `""` | Name to use. |
| `serviceAccount.annotations` | `{}` | ServiceAccount annotations. |
| `serviceAccount.automount` | `false` | Mount the API token. |
| `podAnnotations` / `podLabels` | `{}` | Extra pod metadata. |
| `podSecurityContext` | uid/gid 1000, `runAsNonRoot`, `fsGroup: 1000`, RuntimeDefault seccomp | Pod security context. |
| `securityContext` | read-only root, no privilege escalation, drop ALL | Container security context. |
| `resources` | requests 100m / 256Mi, limit 1Gi memory | Container resources. |
| `startupProbe` | `/health`, up to 10 minutes | Covers first-boot upgrade passes on large vaults. |
| `livenessProbe` / `readinessProbe` | `/health` | Health probes. |
| `nodeSelector` / `tolerations` / `affinity` | empty | Scheduling. |
| `extraVolumes` / `extraVolumeMounts` | `[]` | e.g. a CA bundle for `NODE_EXTRA_CA_CERTS` or `DB_SSL_CA`. |

## Testing the chart

From the repository root, with Docker only:

```bash
docker run --rm --user 1000:1000 -e HOME=/tmp -v "$PWD:/repo:ro" -w /repo \
  --entrypoint sh alpine/helm:3.17.1 deploy/helm/contextnest-community/ci/test.sh /tmp/out
```

`ci/test.sh` runs `helm lint`, renders the value sets in `ci/`, checks the
replica guard refuses unsafe configs, and leaves the renders for kubeconform.
`ci/kind-smoke.sh` installs on a kind cluster and checks `/health` and that a
nest survives a pod delete. CI runs both (`.github/workflows/helm-chart.yml`).
