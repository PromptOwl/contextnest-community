/**
 * AuthorshipChips — tiny initials circles for a document's people: the
 * creator (tinted) plus up to `max` collaborators, "+N" overflow, full
 * emails on tooltips. A shrunk cousin of the Avatar/AvatarFallback initials
 * pattern (TeammatesPage) — plain spans, no Radix, so long document lists
 * stay cheap. Renders nothing when there's nobody to show (old imports).
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

function Chip({
  label,
  title,
  tint,
  size,
}: {
  label: string;
  title: string;
  tint?: boolean;
  size: keyof typeof SIZES;
}) {
  return (
    <span
      title={title}
      className={`flex ${SIZES[size]} shrink-0 items-center justify-center rounded-full border border-background font-medium leading-none ${
        tint ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
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
  return (
    <span className="inline-flex shrink-0 items-center -space-x-1">
      {author && (
        <Chip
          label={initialsOf(author)}
          title={`Created by ${author}`}
          tint
          size={size}
        />
      )}
      {shown.map((email) => (
        <Chip key={email} label={initialsOf(email)} title={email} size={size} />
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
