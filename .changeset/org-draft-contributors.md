---
"@promptowl/contextnest-community": minor
---

Org nests: anyone in the organization can suggest documents and edits as drafts for review without being added (CU-wdqcq05rz6). New nest settings `org_contributions` ("off" | "drafts") and `org_domains` (required on a shared deployment, matched exactly, and only for an IdP-verified email). Contributors keep `read` permission: only `POST /nodes` and `PATCH /nodes/:id` admit them, always as a draft sent to review, and MCP `context_create` / `context_update` / `context_submit_review` behave the same. New `GET /nests/:id/contributions/mine`. The review queue labels their requests "org contributor (not a collaborator)", and it now shows a visibility-only reader only their own requests. Submit-review lets such a reader submit only their own draft. Migration 074 adds `nests.org_contributions`, `nests.org_domains` and `users.email_verified_at`, which OIDC, IdP token exchange and PromptOwl sign-ins now set.
