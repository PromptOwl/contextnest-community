---
"@promptowl/contextnest-community": minor
---

Nest Plugins (behind `FEATURE_PLUGINS`): connect outside sources to a nest through plugins run by the engine's plugin host. A nest admin configures a plugin per nest, and its secrets are stored encrypted in the nest env store, never returned and never handed to workflow runs. Editors can run it now. Every write goes through the nest's normal write path as the plugin's own system identity, so structure rules, the review gate and attribution all apply, and a node a person edited is never overwritten. Available over REST (`/nests/:id/plugins`) and MCP (`context_plugins`, `context_plugin_run`, `context_plugin_configure`). The operator sets the allowlist (`PLUGINS`) and the flag from Settings.
