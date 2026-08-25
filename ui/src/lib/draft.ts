/**
 * Unsaved document edits parked in localStorage until an explicit Save, so the
 * leave dialog's "Discard" can actually throw them away and one editing
 * session yields one server version instead of one per field-exit.
 */

export type LocalDraft = {
  title: string;
  content: string;
  tags: string[];
  schedule: string;
  /** Server version the draft was taken from; a newer server copy wins. */
  baseVersion?: number;
  /** Epoch ms of the last park; drives eviction order when quota bites. */
  savedAt: number;
};

const DRAFT_PREFIX = "contextnest:draft:";

export const draftKey = (nestId: string, nodeId: string) =>
  `${DRAFT_PREFIX}${nestId}:${nodeId}`;

export function readDraft(nestId: string, nodeId: string): LocalDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(nestId, nodeId));
    return raw ? (JSON.parse(raw) as LocalDraft) : null;
  } catch {
    return null;
  }
}

/** Drop the least-recently-parked draft other than `keepKey`; false if none left. */
function evictOldestDraft(keepKey: string): boolean {
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k === keepKey || !k.startsWith(DRAFT_PREFIX)) continue;
    let at = 0;
    try {
      at = Number(JSON.parse(localStorage.getItem(k) || "{}").savedAt) || 0;
    } catch {
      at = 0; // unparseable draft — evict it first
    }
    if (at < oldestAt) {
      oldestAt = at;
      oldestKey = k;
    }
  }
  if (!oldestKey) return false;
  localStorage.removeItem(oldestKey);
  return true;
}

/**
 * Park a draft, evicting older drafts until it fits. A long document is a few
 * hundred KB against a ~5MB origin quota, so this only bites when many large
 * docs are left dirty at once — then the doc being edited wins and the stalest
 * abandoned draft loses. Returns false if it still doesn't fit (or storage is
 * unavailable), so the caller can tell the user their edits aren't backed up.
 */
export function writeDraft(
  nestId: string,
  nodeId: string,
  draft: Omit<LocalDraft, "savedAt">,
): boolean {
  const key = draftKey(nestId, nodeId);
  const value = JSON.stringify({ ...draft, savedAt: Date.now() });
  for (;;) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      // Quota, or storage disabled entirely (private mode / blocked cookies).
      // evictOldestDraft returns false once there's nothing left to free, so
      // an unavailable localStorage exits on the first pass.
      let freed = false;
      try {
        freed = evictOldestDraft(key);
      } catch {
        freed = false;
      }
      if (!freed) return false;
    }
  }
}

export function clearDraft(nestId: string, nodeId: string): void {
  try {
    localStorage.removeItem(draftKey(nestId, nodeId));
  } catch {
    /* ignore */
  }
}
