{{/* Chart name. */}}
{{- define "contextnest-community.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name, truncated to 63 chars (DNS label limit). */}}
{{- define "contextnest-community.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "contextnest-community.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "contextnest-community.labels" -}}
helm.sh/chart: {{ include "contextnest-community.chart" . }}
{{ include "contextnest-community.selectorLabels" . }}
app.kubernetes.io/version: {{ (default .Chart.AppVersion .Values.image.tag) | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "contextnest-community.selectorLabels" -}}
app.kubernetes.io/name: {{ include "contextnest-community.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "contextnest-community.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "contextnest-community.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "contextnest-community.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{- define "contextnest-community.claimName" -}}
{{- default (printf "%s-data" (include "contextnest-community.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{/* "true" when an external Postgres is configured, else "". */}}
{{- define "contextnest-community.postgresConfigured" -}}
{{- with .Values.postgres }}
{{- if or .url .existingSecret .host }}true{{ end }}
{{- end }}
{{- end }}

{{/* "true" when the pod's volume can be shared by several pods. */}}
{{- define "contextnest-community.sharedVolume" -}}
{{- if and .Values.persistence.enabled (eq .Values.persistence.accessMode "ReadWriteMany") }}true{{ end }}
{{- end }}

{{/* Data the chart's own Secret carries; empty means no Secret is rendered. */}}
{{- define "contextnest-community.secretData" -}}
{{- if not .Values.existingSecret }}
{{- with .Values.secrets.promptowlKey }}
PROMPTOWL_KEY: {{ . | b64enc | quote }}
{{- end }}
{{- with .Values.secrets.secretsKey }}
SECRETS_KEY: {{ . | b64enc | quote }}
{{- end }}
{{- range $k, $v := .Values.secrets.env }}
{{ $k }}: {{ toString $v | b64enc | quote }}
{{- end }}
{{- end }}
{{- with .Values.postgres }}
{{- if and .url (not .existingSecret) }}
DATABASE_URL: {{ .url | b64enc | quote }}
{{- end }}
{{- if and .host .password (not .passwordSecret.name) (not .url) (not .existingSecret) }}
DB_PASSWORD: {{ .password | b64enc | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Refuse configurations that lose data. Nests are files on the /data volume and
SQLite is a single file, so two pods may only run together when the metadata is
in Postgres AND the volume is ReadWriteMany (both pods see the same files).
*/}}
{{- define "contextnest-community.validate" -}}
{{- if gt (int .Values.replicaCount) 1 }}
{{- if not (include "contextnest-community.postgresConfigured" .) }}
{{- fail (printf "replicaCount=%d needs an external Postgres (postgres.url, postgres.existingSecret or postgres.host) and ReadWriteMany persistence. Nests are files on the /data volume, and SQLite can't be shared between pods. Keep replicaCount=1, or configure Postgres and set persistence.accessMode=ReadWriteMany." (int .Values.replicaCount)) }}
{{- end }}
{{- if not (include "contextnest-community.sharedVolume" .) }}
{{- fail (printf "replicaCount=%d needs persistence.enabled=true with persistence.accessMode=ReadWriteMany. Nests are files on the /data volume: every pod must read and write the same volume, which a ReadWriteOnce (or no) volume can't give. Keep replicaCount=1, or use ReadWriteMany storage." (int .Values.replicaCount)) }}
{{- end }}
{{- end }}
{{- if not (has .Values.persistence.accessMode (list "ReadWriteOnce" "ReadWriteMany" "ReadWriteOncePod")) }}
{{- fail (printf "persistence.accessMode must be ReadWriteOnce, ReadWriteOncePod or ReadWriteMany (got %q)." .Values.persistence.accessMode) }}
{{- end }}
{{- $secretNames := list "PROMPTOWL_KEY" "SECRETS_KEY" "DATABASE_URL" "DB_PASSWORD" "OIDC_CLIENT_SECRET" "MCP_SIGNING_SECRET" "SMTP_URL" "ANTHROPIC_API_KEY" "SES_SECRET_ACCESS_KEY" "SLACK_WEBHOOK_URL" "MSTEAMS_WEBHOOK_URL" "OFFICIAL_COMMUNITY_SSO_SECRET" "PROMPTOWL_BYPASS_SECRET" "SITE_DOMAIN_CHECK_TOKEN" }}
{{- $reserved := list "PORT" "DATA_ROOT" "AUTH_MODE" "PUBLIC_BASE_URL" "TRUSTED_PROXIES" "NEST_STORAGE_ROOT" "DB_DRIVER" "DB_HOST" "DB_PORT" "DB_USER" "DB_NAME" "DB_SSL" "DB_POOL_MAX" }}
{{- range $k, $_ := .Values.config.env }}
{{- if has $k $reserved }}
{{- fail (printf "config.env.%s is set by the chart itself. Use its dedicated value instead (config.authMode, config.publicBaseUrl, config.trustedProxies, config.nestStorageRoot, postgres.*); PORT and DATA_ROOT are fixed at 3838 and /data." $k) }}
{{- end }}
{{- if has $k $secretNames }}
{{- fail (printf "config.env.%s is a secret, and config.env is rendered into a plain ConfigMap. Put it under secrets.env (or in existingSecret) instead." $k) }}
{{- end }}
{{- end }}
{{- if and .Values.postgres.url .Values.postgres.existingSecret }}
{{- fail "Set postgres.url or postgres.existingSecret, not both." }}
{{- end }}
{{- end }}
