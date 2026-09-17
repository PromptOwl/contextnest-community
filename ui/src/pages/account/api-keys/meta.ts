import { KeyRound } from "lucide-react";
import type { AccountPageMeta } from "../../../lib/account-pages";

export const meta: AccountPageMeta = {
  path: "/api-keys",
  label: "API keys",
  icon: KeyRound,
  order: 20,
  viewPage: "api-keys",
};
