import { config } from "../config.js";
import { getModelGateway } from "../auth/license.js";
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

/** Env names a server or nest stores its own Anthropic credential under. */
export const OWN_KEY_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;

/** Model when the admin picked none and nothing else names one: Anthropic's id. */
export const DIRECT_DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Pricing spec §6.1/§9.3: the server's own key only with the `byok` licence
 * feature (Enterprise); otherwise PromptOwl's gateway, metered in credits.
 * A nest's own key beats the server's. Key and URL come as a pair from one
 * source, so a nest URL never receives the server's key. null = nothing to call with.
 * ponytail: Anthropic only; another provider = its env names + gateway route here.
 */
export function resolveModelCredential(
  nestEnv: Record<string, string> = {},
): ModelCredential | null {
  if (hasEntitlement("byok")) {
    if (nestEnv.ANTHROPIC_API_KEY) {
      return { apiKey: nestEnv.ANTHROPIC_API_KEY, baseUrl: nestEnv.ANTHROPIC_BASE_URL || null, source: "own", defaultModel: null };
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return { apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: config.ANTHROPIC_BASE_URL || null, source: "own", defaultModel: null };
    }
  }
  const gateway = getModelGateway();
  return gateway
    ? { apiKey: gateway.key, baseUrl: gateway.baseUrl, source: "promptowl", defaultModel: gateway.defaultModel }
    : null;
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
