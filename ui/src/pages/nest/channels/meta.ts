import { MessagesSquare } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "chat",
  // The page shipped as /channels (PO-1189); links to it still open the chat.
  legacyPaths: ["channels"],
  label: "Chat",
  icon: MessagesSquare,
  order: 6,
  viewPage: "channels",
  beta: true,
  // Experimental (EXPERIMENTAL_AGENT_STREAM, PO-1179): listed only while the
  // server has channels on, and only for people added to the nest (PO-1190).
  // Every member reads and posts, read-only collaborators included; a public
  // reader or a document-share-only grantee has no channels to open.
  // Since C2 (PO-1197) the nest says so itself (`chat`): its owner can turn
  // chat off for the nest alone.
  visible: (caps) => (typeof caps.chatOn === "boolean" ? caps.chatOn : !!caps.agentStreamEnabled && caps.isMember === true),
};
