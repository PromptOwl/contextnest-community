/**
 * Shape check for a PostHog project API key: `phc_` plus a long
 * alphanumeric token (real keys are ~43 characters after the prefix).
 * Returns the reason a value is rejected, or null when it passes; the empty
 * string passes because clearing the key is how analytics is turned off.
 */
export const POSTHOG_KEY_MIN_TOKEN = 20;

export function posthogKeyError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!v.startsWith("phc_"))
    return "PostHog project key must start with phc_ — copy the project API key from PostHog settings.";
  const token = v.slice(4);
  if (!/^[A-Za-z0-9]*$/.test(token))
    return "PostHog project key may only contain letters and digits after phc_ — check for spaces or punctuation.";
  if (token.length < POSTHOG_KEY_MIN_TOKEN)
    return `PostHog project key looks too short — a real key is about 47 characters long (phc_ plus ${POSTHOG_KEY_MIN_TOKEN}+ letters and digits). Copy the whole key from PostHog settings.`;
  return null;
}
