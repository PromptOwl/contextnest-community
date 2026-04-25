# ContextNest Community Edition

**Self-hosted context governance server for AI workflows.** Part of the [PromptOwl](https://promptowl.ai) platform.

> ⚠️ **Commercial Software.** ContextNest Community Edition is proprietary software licensed by Promptowl LLC. A free [PromptOwl account](https://app.promptowl.ai) is required to use it. Redistribution, hosting-as-a-service, and competitive use are prohibited. See [LICENSE.md](./LICENSE.md) for full terms.

---

## What it is

ContextNest Community Edition is a self-hosted server that lets you:

- Store, version, and govern markdown-based context documents ("nests")
- Apply stewardship workflows — draft, pending review, approved
- Serve approved context to AI agents via MCP, HTTP, or CLI
- Sync with the PromptOwl hosted platform for multi-user collaboration

The server runs locally or on your own infrastructure. Your PromptOwl account handles authentication, entitlement, and governance metadata.

## Quickstart

```bash
# 1. Get a license key — sign up free at https://app.promptowl.ai
#    Settings → License Keys → Create a Community Server key

# 2. (Optional) Scaffold a local nest with the open-source CLI
npx @promptowl/contextnest-cli init

# 3. Run the community server
PROMPTOWL_KEY=pk_... npx @promptowl/contextnest-community
```

The server listens on `http://localhost:3000` by default. Without a valid `PROMPTOWL_KEY` the server still runs but some features are limited. See [CONFIGURATION.md](./CONFIGURATION.md) for all environment variables (port, auth mode, storage, telemetry).

## System requirements

- **Node.js** 20.x or later
- **PromptOwl account** — free signup at <https://app.promptowl.ai/signup>
- **OS:** Windows, macOS, or Linux
- **Disk:** ~200 MB for the server, plus storage for your nests

## What you get

| Feature | Community Edition | Enterprise |
|---|:---:|:---:|
| Self-hosted context server | ✅ | ✅ |
| Markdown + YAML frontmatter vaults | ✅ | ✅ |
| Stewardship workflow (draft/review/approve) | ✅ | ✅ |
| MCP server for AI agents | ✅ | ✅ |
| Multi-user governance UI | — | ✅ |
| SSO / SAML / SCIM | — | ✅ |
| Audit log streaming | — | ✅ |
| Policy transforms (redaction, summarization) | — | ✅ |
| Priority support and SLA | — | ✅ |

For Enterprise pricing and features, contact **hoot@promptowl.ai** or visit <https://promptowl.ai/contextnest/>.

## Licensing

ContextNest Community Edition is **commercial software**. It is **not open source**.

**You may:**
- Install and run the Software on devices You own or control
- Use the Software for internal business purposes, tied to a valid PromptOwl account
- Make backup and archival copies

**You may not:**
- Redistribute, resell, rent, lease, or sublicense the Software
- Offer the Software as a hosted, managed, or software-as-a-service product to third parties
- Reverse engineer, decompile, or create derivative works
- Use the Software to build a competing product or service
- Remove copyright, trademark, or license notices

Full license text: [LICENSE.md](./LICENSE.md)

**For redistribution, hosted-service, OEM, or regulated-industry use,** contact **hoot@promptowl.ai** for a commercial license agreement.

## Platform terms

Because the Software requires a PromptOwl account, the following terms also apply to Your use:

- **End User License Agreement** — <https://promptowl.ai/eula/>
- **Terms of Service** — <https://promptowl.ai/terms-of-service/>
- **Privacy Policy** — <https://promptowl.ai/privacy-policy/>
- **Acceptable Use Policy** — <https://promptowl.ai/acceptable-use/>
- **Disclaimer** — <https://promptowl.ai/disclaimer/>
- **Cookie Policy** — <https://promptowl.ai/cookies/>

## Support

- **Documentation:** <https://promptowl.ai/contextnest/>
- **Product questions:** <https://promptowl.ai/contact-us/>
- **Support & bugs:** `hoot@promptowl.ai`
- **Commercial licensing:** `hoot@promptowl.ai` (subject: *ContextNest Commercial License*)

## AI output disclaimer

The Software injects content into large language models. AI output may be inaccurate, incomplete, or inappropriate for your use case. You are responsible for reviewing and validating any AI-generated content before relying on it, particularly in business-critical or regulated contexts. Do not deploy the Software in medical, legal, financial-advisory, or safety-critical environments without appropriate human oversight.

---

**Copyright © 2026 Promptowl LLC.** All rights reserved.
"ContextNest" and "PromptOwl" are trademarks of Promptowl LLC.

Promptowl LLC · 3060 Mercer University Dr Ste 110 · Atlanta, GA 30341 · USA
