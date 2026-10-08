import { getModelGateway, getOwnGateway, OWN_KEY_PROVIDERS, setOwnProviderKey, validateLicense } from "../auth/license.js";
import { persistSetting } from "../db/settings.js";
import { hasEntitlement } from "../auth/entitlements.js";

/** Which key a model call uses, and where it goes. */
export interface ModelCredential {
  apiKey: string;
  baseUrl: string | null;
  /** own = the customer's key (unmetered); promptowl = the licence gateway (credits). */
  source: "own" | "promptowl";
  /** The gateway's default model name (PromptOwl team names, e.g. "default-claude/…"). */
  defaultModel: string | null;
}

/** Env names a nest stores its own Anthropic credential under (agent runs). */
export const OWN_KEY_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;

/** Model when the admin picked none and nothing else names one: Anthropic's id. */
export const DIRECT_DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Pricing spec §6.1/§9.3: a nest's own key only with the `byok` licence
 * feature (Enterprise); otherwise PromptOwl's gateway, metered in credits.
 * The server's own keys live in PromptOwl's gateway and are picked per model
 * (ownModelRoute). Key and URL come as a pair. null = nothing to call with.
 */
export function resolveModelCredential(
  nestEnv: Record<string, string> = {},
): ModelCredential | null {
  if (hasEntitlement("byok") && nestEnv.ANTHROPIC_API_KEY) {
    return { apiKey: nestEnv.ANTHROPIC_API_KEY, baseUrl: nestEnv.ANTHROPIC_BASE_URL || null, source: "own", defaultModel: null };
  }
  const gateway = getModelGateway();
  return gateway
    ? { apiKey: gateway.key, baseUrl: gateway.baseUrl, source: "promptowl", defaultModel: gateway.defaultModel }
    : null;
}

/**
 * The server-wide Anthropic key moved into PromptOwl's model gateway (an
 * own-provider key, like OpenAI). Boot hands a stored one over once, then
 * drops it here. Without byok it stays put, unused, until the licence has it.
 */
export async function moveStoredAnthropicKey(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !hasEntitlement("byok")) return;
  const refused = await setOwnProviderKey("claude", key);
  if (refused) {
    console.warn(`[license] could not move the stored Anthropic key to the model gateway: ${refused}`);
    return;
  }
  await persistSetting("ANTHROPIC_API_KEY", null);
  delete process.env.ANTHROPIC_API_KEY;
  await validateLicense({ forceFresh: true });
  console.log("[license] stored Anthropic key moved to the model gateway (Settings → Hootie → Model keys)");
}

/** "default-openai/gpt-4o" → "openai": the provider is the group's last dash part. */
const providerOf = (callModel: string): string | null => {
  const slash = callModel.indexOf("/");
  return slash > 0 ? callModel.slice(0, slash).split("-").pop() || null : null;
};

/** For the model picker's groups: a gateway id's provider, else a bare claude name's, else "other". */
export const modelProvider = (id: string): string =>
  providerOf(id) ?? (/^claude/i.test(id) ? "claude" : "other");

/**
 * With byok, a call whose provider has an own key (Settings → Other model
 * providers) goes on that key, renamed onto the licence's own model group:
 * "default-openai/gpt-4o" → "community-<licence>-openai/gpt-4o" (the own model
 * is a provider wildcard, so any of its model names works). null = keep today's key.
 */
export function ownModelRoute(callModel: string): { credential: ModelCredential; model: string } | null {
  if (!hasEntitlement("byok")) return null;
  const own = getOwnGateway();
  const provider = providerOf(callModel);
  // Only providers an admin can add a key for. ponytail: the provider is the
  // group's last dash part (PromptOwl's groups are "<instance>-<provider>"), so a
  // group like "team-azure-openai" would read as openai; match exact groups if one appears.
  if (!own || !provider || !(OWN_KEY_PROVIDERS as readonly string[]).includes(provider)) return null;
  const group = own.models.map((m) => m.slice(0, m.indexOf("/"))).find((g) => providerOf(`${g}/`) === provider);
  if (!group) return null;
  return {
    credential: { apiKey: own.key, baseUrl: own.baseUrl, source: "own", defaultModel: null },
    model: `${group}/${callModel.slice(callModel.indexOf("/") + 1)}`,
  };
}

/** For logs: which key a call uses and why; the key only by its last 4 characters. */
export function credentialLabel(c: ModelCredential): string {
  const via =
    c.source === "promptowl" ? "promptowl-credits" : getOwnGateway()?.key === c.apiKey ? "own-provider(LiteLLM)" : "nest-key";
  return `key=${via} …${c.apiKey.slice(-4)} base=${c.baseUrl || "anthropic"}`;
}

/** "default-claude/claude-sonnet-5" → "claude-sonnet-5": PromptOwl's instance prefix off. */
export function bareModelName(id: string): string {
  const i = id.indexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}

/**
 * The model Hootie asks for, as people see and store it (no instance prefix):
 * the admin's pick (Settings → Hootie), else the gateway's default, else
 * Anthropic's id. resolveGatewayModel adds the prefix at call time.
 */
export function hootieModel(credential: ModelCredential | null): string {
  if (process.env.HOOTIE_MODEL) return process.env.HOOTIE_MODEL;
  return credential?.defaultModel ? bareModelName(credential.defaultModel) : DIRECT_DEFAULT_MODEL;
}

/** Model ids a credential's endpoint lists (`/v1/models`), cached 5 min per key. */
const listCache = new Map<string, { at: number; ids: string[] }>();
export async function listCredentialModels(credential: ModelCredential): Promise<string[]> {
  const base = (credential.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const cacheKey = `${base}|${credential.apiKey}`;
  const hit = listCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ids;
  const res = await fetch(`${base}/v1/models`, {
    headers: {
      // Anthropic reads x-api-key; LiteLLM accepts the bearer form too.
      "x-api-key": credential.apiKey,
      authorization: `Bearer ${credential.apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`model list answered ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  listCache.set(cacheKey, { at: Date.now(), ids });
  return ids;
}

/**
 * The name to send. On PromptOwl's gateway a stored "claude-sonnet-5" becomes
 * the team's "default-claude/claude-sonnet-5" (the prefix is PromptOwl's
 * instance name and can change, so it is looked up, never stored). A name that
 * already carries a prefix, and any own-key (byok) call, go as given.
 */
export async function resolveGatewayModel(credential: ModelCredential, name: string): Promise<string> {
  if (credential.source !== "promptowl" || name.includes("/")) return name;
  if (credential.defaultModel && bareModelName(credential.defaultModel) === name) {
    return credential.defaultModel;
  }
  try {
    return (await listCredentialModels(credential)).find((id) => bareModelName(id) === name) ?? name;
  } catch {
    return name; // the gateway's own error will name the model
  }
}
