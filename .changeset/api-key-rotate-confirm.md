---
"@promptowl/contextnest-community": patch
---

Ask for confirmation before rotating an API key. Rotate on the API keys page
and in the Connect dialog now opens a confirmation dialog that names the key
and warns that the current key
stops working immediately, instead of rotating on the first click.
Revoke on the API keys page uses the same in-app confirmation dialog instead
of the browser's native confirm popup.
