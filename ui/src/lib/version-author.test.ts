import { describe, it, expect } from "vitest";
import {
  versionAgent,
  versionAuthorShort,
  clientTitle,
  lastEditParts,
} from "./version-author";

describe("versionAgent", () => {
  it("reads the agent from the client block", () => {
    expect(versionAgent({ client: { agent: "mkt-amplifier" } })).toBe("mkt-amplifier");
  });

  it("is null with no client, no agent, or a blank agent", () => {
    expect(versionAgent({})).toBeNull();
    expect(versionAgent({ client: { session_id: "s-1" } })).toBeNull();
    expect(versionAgent({ client: { agent: "  " } })).toBeNull();
    expect(versionAgent({ client: null })).toBeNull();
  });
});

describe("versionAuthorShort (the Compare dropdown)", () => {
  it("puts the human first and the agent after", () => {
    expect(
      versionAuthorShort({
        editedBy: "misha@x.com",
        client: { agent: "mkt-amplifier" },
      }),
    ).toBe("misha via mkt-amplifier");
  });

  it("renders as before when no agent was recorded", () => {
    expect(versionAuthorShort({ editedBy: "taimur@x.com" })).toBe("taimur");
    expect(
      versionAuthorShort({ editedBy: "taimur@x.com", client: { session_id: "s" } }),
    ).toBe("taimur");
  });

  it("keeps a system human as stored, and still names the agent", () => {
    expect(
      versionAuthorShort({
        editedBy: "system:drift@nest.local",
        editedBySystem: "Drift scan",
        client: { agent: "runner" },
      }),
    ).toBe("Drift scan via runner");
    expect(
      versionAuthorShort({
        editedBy: "cli@contextnest.local",
        client: { agent: "ctx" },
      }),
    ).toBe("cli via ctx");
  });

  it("never lets the agent stand in for a missing human", () => {
    expect(versionAuthorShort({ client: { agent: "ctx" } })).toBe("via ctx");
    expect(versionAuthorShort({})).toBeNull();
  });
});

describe("clientTitle (hover detail)", () => {
  it("labels every key, agent first", () => {
    expect(
      clientTitle({ session_id: "s-9f2", agent: "claude-code", run: 7 }),
    ).toBe("agent: claude-code · session: s-9f2 · run: 7");
  });

  it("is undefined with nothing to show", () => {
    expect(clientTitle(undefined)).toBeUndefined();
    expect(clientTitle({})).toBeUndefined();
  });
});

describe("lastEditParts (the document byline)", () => {
  const people = [{ email: "misha@x.com", name: "Misha" }];

  it("names the human by display name, then the agent", () => {
    expect(
      lastEditParts(
        { edited_by: "misha@x.com", client: { agent: "mkt-amplifier" } },
        people,
      ),
    ).toEqual({ human: "Misha", agent: "mkt-amplifier" });
  });

  it("falls back to the email, and leaves the agent out when none", () => {
    expect(lastEditParts({ edited_by: "sam@x.com" }, people)).toEqual({
      human: "sam@x.com",
      agent: null,
    });
  });

  it("uses a system account's name as stored", () => {
    expect(
      lastEditParts(
        {
          edited_by: "system:x@nest.local",
          edited_by_system: "Importer",
          client: { agent: "ctx" },
        },
        people,
      ),
    ).toEqual({ human: "Importer", agent: "ctx" });
  });

  it("is null without a last edit or a human", () => {
    expect(lastEditParts(null, people)).toBeNull();
    expect(lastEditParts(undefined, people)).toBeNull();
    expect(lastEditParts({ edited_by: "" }, people)).toBeNull();
  });
});
