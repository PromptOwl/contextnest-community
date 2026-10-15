import { FolderTree } from "lucide-react";
import type { NestPageMeta } from "../../../lib/nest-pages";

export const meta: NestPageMeta = {
  path: "structure",
  label: "Structure",
  icon: FolderTree,
  order: 5,
  viewPage: "structure",
  // Each nest has its own rules. Everyone who works in the nest can see them
  // (owners and admins edit); a docs-site reader is never shown them.
  visible: (caps) => !caps.isReaderView,
};
