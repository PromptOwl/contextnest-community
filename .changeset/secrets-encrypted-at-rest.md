---
"@promptowl/contextnest-community": minor
---

Stored credentials are now encrypted at rest. The secret server settings (Anthropic API key, OIDC client secret, MCP signing secret, SMTP URL, Slack and Teams webhook URLs, the license key) and every value in a nest's Tool environment are stored AES-256-GCM encrypted instead of in the clear, so a database dump, replica or backup no longer carries the credentials with it. Non-secret settings stay readable. The master key is generated on first use and kept in the database, so it survives redeploys and is shared by every instance with nothing to configure; set SECRETS_KEY in the deploy environment to supply your own instead and keep the key out of the database it protects. Values written before this are read back as plaintext and re-encrypted on their next save — nothing to migrate — and a value that cannot be decrypted is logged by name and treated as unset rather than failing the boot.
