import type { SearchableOption } from "@/components/SearchableSelect";

/** Picker headings for the providers /admin/models names. */
const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  claude: "Anthropic",
  gemini: "Google Gemini",
  grok: "xAI Grok",
  groq: "Groq",
  perplexity: "Perplexity",
};

/**
 * The Hootie model picker's options, grouped by provider. A provider with an
 * own key (byok) gets "· your key" in its heading: every model under it runs
 * on that key. The own-model names themselves (`community-<licence>-openai/…`)
 * only show when nothing else lists that provider's models, so each model is
 * listed once. The saved model stays selectable even if no key lists it.
 */
export function modelOptions(
  models: string[],
  own: string[],
  providers: Record<string, string>,
  value: string,
): SearchableOption[] {
  const ownProviders = new Set(own.map((m) => providers[m]));
  const listed = new Set(models.filter((m) => !own.includes(m)).map((m) => providers[m]));
  const heading = (p: string | undefined) =>
    `${PROVIDER_LABELS[p ?? ""] ?? "Other"}${p && ownProviders.has(p) ? " · your key" : ""}`;
  const options = models
    .filter((m) => !own.includes(m) || !listed.has(providers[m]))
    .map((m) => ({
      value: m,
      label: own.includes(m) ? m.slice(m.indexOf("/") + 1) : m,
      group: heading(providers[m]),
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  if (value && !options.some((o) => o.value === value)) {
    options.unshift({ value, label: value, group: "Current" });
  }
  return options;
}
