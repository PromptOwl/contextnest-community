import { Hash } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "channels",
  label: "Channels",
  icon: Hash,
  order: 6,
  viewPage: "channels",
  beta: true,
  // Experimental (EXPERIMENTAL_AGENT_STREAM, PO-1179): listed only while the
  // server has channels on, and only for people added to the nest (PO-1190).
  // Every member reads and posts, read-only collaborators included; a public
  // reader or a document-share-only grantee has no channels to open.
  visible: (caps) => !!caps.agentStreamEnabled && caps.isMember === true,
};
