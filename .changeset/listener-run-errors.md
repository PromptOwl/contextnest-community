---
"@promptowl/contextnest-community": patch
---

A Slack listener run that ends without a usable decision is now a failed run that says why (out of output tokens, no decision submitted, or which rule the decision broke), in Workflows, Agents activity and the Control room ledger, with its tokens and duration. Errors without a fixed explanation show the provider's own message, with credentials and conversation text taken out, and every failure is logged.
