/**
 * AuthorshipChips — tiny initials circles for a document's people: the
 * creator (primary tint) plus up to `max` collaborators in per-person colours,
 * "+N" overflow, full emails on tooltips. A shrunk cousin of the
 * Avatar/AvatarFallback initials pattern (TeammatesPage) — plain spans, no
 * Radix, so long document lists stay cheap. Renders nothing when there's
 * nobody to show (old imports).
 */

export function initialsOf(email: string): string {
  const local = (email.split("@")[0] || "").trim();
  if (!local) return "?";
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const two =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return two.toUpperCase();
}

const SIZES = {
  sm: "h-4 w-4 text-[8px]",
  md: "h-5 w-5 text-[9px]",
} as const;

/**
 * Collaborator tints. Initials collide constantly on firstname@company.com
 * rosters (alan/albert/alice all give "AL"), so colour carries the "these are
 * different people" signal that two letters can't. Tooltips remain the way to
 * identify *which* person — colour only has to separate, not name.
 *
 * Full literal class strings: Tailwind scans source text, so an interpolated
 * `bg-${hue}-500/15` would never be generated. Deliberately excludes primary
 * (reserved for the creator chip) and muted (the "+N" chip).
 */
const TINTS = [
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
] as const;

/**
 * FNV-1a plus a murmur3 finalizer, mod TINTS. Stable across reloads and
 * machines, so a person keeps their colour between visits.
 *
 * The finalizer is load-bearing, not cargo cult: `% TINTS.length` reads only
 * the low bits, and raw FNV-1a mixes those poorly for strings sharing a
 * suffix — every address on one team ends `@company.com`, which was enough to
 * drive alan/albert/alice onto a single colour. The avalanche pulls high-bit
 * entropy down before the modulo.
 */
function tintIndexOf(email: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < email.length; i++) {
    hash ^= email.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % TINTS.length;
}

/**
 * Preferred colour per email, then linear-probe collisions off each other.
 *
 * Hashing alone doesn't meet the bar: drawing 3 people from 8 colours collides
 * ~34% of the time (birthday problem), and a collision is the one thing the
 * chips exist to prevent. Probing guarantees every chip in a row differs; the
 * hash still decides the common no-collision case, so colours stay stable.
 * Rosters longer than the palette necessarily repeat — bounded by `max`, which
 * every caller keeps well under TINTS.length.
 */
function assignTints(emails: string[]): string[] {
  const taken = new Set<number>();
  return emails.map((email) => {
    const preferred = tintIndexOf(email);
    for (let probe = 0; probe < TINTS.length; probe++) {
      const candidate = (preferred + probe) % TINTS.length;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return TINTS[candidate];
      }
    }
    return TINTS[preferred];
  });
}

function Chip({
  label,
  title,
  tint,
  size,
}: {
  label: string;
  title: string;
  /** Tailwind bg/text classes; defaults to the neutral muted chip. */
  tint?: string;
  size: keyof typeof SIZES;
}) {
  return (
    <span
      title={title}
      className={`flex ${SIZES[size]} shrink-0 items-center justify-center rounded-full border border-background font-medium leading-none ${
        tint ?? "bg-muted text-muted-foreground"
      }`}
    >
      {label}
    </span>
  );
}

export function AuthorshipChips({
  author,
  collaborators = [],
  max = 3,
  size = "sm",
}: {
  author?: string | null;
  collaborators?: string[];
  /** Collaborator chips shown before collapsing into "+N". */
  max?: number;
  size?: keyof typeof SIZES;
}) {
  if (!author && collaborators.length === 0) return null;
  const shown = collaborators.slice(0, max);
  const overflow = collaborators.length - shown.length;
  const tints = assignTints(shown);
  return (
    <span className="inline-flex shrink-0 items-center -space-x-1">
      {author && (
        <Chip
          label={initialsOf(author)}
          title={`Created by ${author}`}
          tint="bg-primary/15 text-primary"
          size={size}
        />
      )}
      {shown.map((email, i) => (
        <Chip
          key={email}
          label={initialsOf(email)}
          title={email}
          tint={tints[i]}
          size={size}
        />
      ))}
      {overflow > 0 && (
        <Chip
          label={`+${overflow}`}
          title={collaborators.slice(max).join(", ")}
          size={size}
        />
      )}
    </span>
  );
}
