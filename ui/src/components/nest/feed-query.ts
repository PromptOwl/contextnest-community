/** First page of comment activity — the Review tab renders it, NestView
 *  reads the total off it to decide whether the tab shows at all. Lives here
 *  (not in ReviewTab) so NestView can lazy-load the tab and still gate. */
import { useQuery } from "@tanstack/react-query";
import { reads } from "../../lib/queries";

export const FEED_PAGE = 50;

export function useFeedComments(nestId: string, enabled = true) {
  return useQuery({ ...reads.feed(nestId, "comments", FEED_PAGE, 0), enabled });
}
