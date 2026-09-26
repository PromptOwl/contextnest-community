/**
 * Admin topics for the How it works page (Help group). Plain data so a test
 * can check that each topic exists and that every UI location it names is
 * one the app actually renders. The page draws them; the full admin guides
 * live in CONFIGURATION.md, which ships with the server package.
 */
export interface HelpTopic {
  id: string;
  title: string;
  /** Where the admin goes in the app: "Admin → <page> → <tab>". */
  where: string;
  summary: string;
  steps: string[];
  notes: string[];
}

export const ADMIN_HELP_TOPICS: HelpTopic[] = [
  {
    id: "sso",
    title: "Single sign-on (OIDC)",
    where: "Admin → Server settings → Single sign-on",
    summary:
      "Let people sign in with your identity provider: Microsoft Entra ID, Google, Okta, Keycloak or any OpenID Connect issuer. It is one setup for the whole server, and only a server admin can change it.",
    steps: [
      "Set Public base URL (Server settings → General) to the https address people use, e.g. https://nest.acme.com. The redirect URI is built from it: <Public base URL>/auth/oidc/callback. The Single sign-on tab shows it with a Copy button.",
      "At your identity provider, register a web app (confidential client) with that exact redirect URI. Copy its client ID and client secret.",
      "On the Single sign-on tab, pick Microsoft Entra ID or Google, or paste your issuer URL. Then paste the client ID and secret.",
      "Optional: list your allowed email domains, and turn Auto-provision off if only invited people should get in.",
      "Turn it on, Save, then test in a private window. The login page shows a Sign in with Microsoft / Google / SSO button.",
    ],
    notes: [
      "People are matched by email. Someone who already has a password account with the same email signs into that account, and their password still works.",
      "API keys (cnst_…) do not go through SSO. Disabling someone at your identity provider does not stop their keys or their open sessions. Remove them under Admin → Teammates to end both.",
      "A failed sign-in comes back with a short error. Each code, what causes it and how to fix it are listed in CONFIGURATION.md → Single sign-on (OIDC) → Troubleshooting.",
    ],
  },
];

export function helpTopic(id: string): HelpTopic {
  const t = ADMIN_HELP_TOPICS.find((x) => x.id === id);
  if (!t) throw new Error(`No help topic "${id}"`);
  return t;
}
