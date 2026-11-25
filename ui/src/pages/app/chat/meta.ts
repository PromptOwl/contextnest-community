import { MessagesSquare } from "lucide-react";
import type { PageMeta } from "../../../lib/pages";

// The rail draws its own Chat row (with the badge), so the page stays out of
// the registry's rows.
export const meta: PageMeta = { path: "/chat", label: "Chat", icon: MessagesSquare, order: 4, hidden: true };
