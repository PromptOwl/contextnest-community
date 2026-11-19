---
"@promptowl/contextnest-community": patch
---

Control room → Setup now has a Disconnect Slack button once a workspace is connected (po-1436). A confirm dialog says what goes and what stays: pending review cards are withdrawn, the Slack token is revoked, and channel bindings, drafts and linked Slack users are removed; approved notes, nest access and the audit history stay. The wizard then returns to Connect Slack so a different workspace can be connected. It uses the existing admin `DELETE /surfaces/installs/:id`.
