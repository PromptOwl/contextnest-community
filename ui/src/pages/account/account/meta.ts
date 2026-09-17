import { UserRound } from "lucide-react";
import type { AccountPageMeta } from "../../../lib/account-pages";

export const meta: AccountPageMeta = {
  path: "/account",
  label: "Account",
  icon: UserRound,
  order: 26,
  viewPage: "account",
};
