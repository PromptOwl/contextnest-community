import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { z } from "zod";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Email validation for user-entered addresses (collaborators, stewards, team
 * members) — instant client feedback. The server (isEmailish in src/config.ts)
 * enforces the same via zod and is the source of truth; this just avoids a
 * round-trip for obvious garbage like `*'/*'/8////@gmail.com`.
 */
const EMAIL_SCHEMA = z.email();
export function isEmailish(v: string): boolean {
  return EMAIL_SCHEMA.safeParse(v.trim()).success;
}

export function isSafeUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}
