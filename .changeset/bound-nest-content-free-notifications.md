---
"@promptowl/contextnest-community": patch
---

The server-wide Slack/Teams webhook and a nest's outbound connectors no longer block binding a Slack channel to a nest (po-1431). Before, setting `SLACK_WEBHOOK_URL` made the setup wizard refuse every channel with "also read by outbound connectors". Now, once a nest is bound to a conversation, everything those channels receive for it is content-free: the event kind and the nest name with "open ContextNest", a digest of "N updates", raw webhooks with no subject, and a count-only team-inbox email. Nests that aren't bound keep their full messages. Adding or removing the webhook no longer re-checks or pauses bound channels.
