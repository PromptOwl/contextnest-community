/**
 * What a card may SAY when the conversation has people who can't read the
 * nest (`surface_ok = false`) — security rounds 2 (H1) and 3 (N1).
 *
 * Model-written text is nest-derived until proven otherwise, and no token
 * heuristic proves it (round 3 showed seeded digits, non-ASCII digits and
 * short words all slip through one). So when !surface_ok the card carries
 * NO model-written title or summary at all, for every kind: only a fixed
 * sentence naming the kind and the nest. When surface_ok holds nothing
 * changes. Pure.
 */
const KIND_WORDS: Record<string, string> = {
  decision: "decision",
  fact: "fact",
  how_we_work: "way of working",
  owner_deadline: "commitment",
  correction: "correction",
  agent_suggestion: "agent",
};

export interface CardItem {
  kind: string;
  op: string;
}

/** The fixed card text for a conversation that isn't all readers. */
export function fixedCardText(items: CardItem[], nestName: string): { title: string; summary: string } {
  if (items.length > 1) return { title: `${items.length} proposals from this conversation are waiting for review in ${nestName}`, summary: "" };
  const kind = items[0]?.op === "edit" ? "correction" : (KIND_WORDS[items[0]?.kind ?? ""] ?? "item");
  return { title: `A proposed ${kind} from this conversation is waiting for review in ${nestName}`, summary: "" };
}
