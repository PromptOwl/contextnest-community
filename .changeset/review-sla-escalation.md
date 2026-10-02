---
"@promptowl/contextnest-community": minor
---

New nest setting "Review SLA (hours)" (`review_sla_hours`, off by default). In a governed nest, a review left pending past the SLA escalates one rung — tag reviewers, then nest reviewers, then the nest owner — with each rung notified once through the inbox, connectors (`review_escalated`) and email. The rung is recorded on the review (`escalationLevel`, `escalatedAt`) so restarts and concurrent instances never re-notify. Approval rights and separation of duties are unchanged.
