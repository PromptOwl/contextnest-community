---
"@promptowl/contextnest-community": minor
---

Server admins can stop nest owners making nests public or organization-wide. Two new settings, **Who can make nests public** and **Who can make nests organization-wide** (Server settings → Features → Nest visibility, `/admin/settings` fields `nest_public_visibility` / `nest_org_visibility`, env `NEST_PUBLIC_VISIBILITY` / `NEST_ORG_VISIBILITY`), are each `owners` (the default, today's behaviour) or `admins`. With `admins`, only a server admin can widen a nest to that tier: anyone else gets a `403` (`code: "visibility_restricted"`) naming the setting, and the visibility pickers show the tier disabled with the reason. Making a nest narrower is always allowed, and nests that are already public or organization-wide stay as they are. `GET /health` reports both settings.
