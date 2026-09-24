---
"@promptowl/contextnest-community": minor
---

Email can now be sent through AWS SES as well as SMTP. Server settings → Notifications → Email has an SMTP / AWS SES choice; SES takes a region and optional access keys (leave them empty to use the server's IAM role). Credentials are verified on save, the SES secret is write-only, and saving one provider clears the other's settings. New settings: `EMAIL_PROVIDER`, `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`. `GET /admin/settings` now also returns `email_provider`, `ses_region`, `ses_access_key_id` and `ses_secret_access_key_set`.
