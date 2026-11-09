/** Stub — filled in by the PO-1180 implementation commit. */
export type AgentMentionResolver = (caller: { userId: string; email: string }) => Promise<string[]>;
export function setAgentMentionResolver(_fn: AgentMentionResolver | null): void {}
