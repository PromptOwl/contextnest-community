import { describe, it, expect } from "vitest";
import { isTicketTag, ticketOf, visibleTags } from "./ticket";

describe("ticket tags", () => {
  it("reads the number off the tag", () => {
    expect(ticketOf(["#community", "#ticket:cmn-12"])).toBe("CMN-12");
    expect(ticketOf(["ticket:DOC-500"])).toBe("DOC-500");
  });
  it("is undefined for an unnumbered task", () => {
    expect(ticketOf(["#community"])).toBeUndefined();
    expect(ticketOf(undefined)).toBeUndefined();
    expect(ticketOf(["#ticket:nonsense"])).toBeUndefined();
  });
  it("hides only the ticket tag from the chips", () => {
    expect(visibleTags(["#a", "#ticket:cn-1", "#stage:backlog"])).toEqual(["#a", "#stage:backlog"]);
    expect(isTicketTag("#ticket:cn-1")).toBe(true);
    expect(isTicketTag("#tickets")).toBe(false);
  });
});
