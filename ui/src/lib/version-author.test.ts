import { describe, it, expect } from "vitest";
import {
  versionAgent,
  versionAuthorShort,
  clientTitle,
  lastEditParts,
  rowLastEdit,
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

// po-1213: every Documents row and feed item names its last editor.
describe("AC-NH-03/04: rowLastEdit (Documents rows and the feed)", () => {
  const people = [{ email: "priya@larkspur.example", name: "Priya Raman" }];

  it("Given an agent wrote the latest version, then it reads '<human> via <agent>', human first", () => {
    const r = rowLastEdit(
      {
        updated_at: "2026-11-01T00:00:00Z",
        last_edit: { edited_by: "priya@larkspur.example", edited_at: "2026-11-02T00:00:00Z", client: { agent: "mkt-amplifier" } },
      },
      people,
    );
    // The time is updated_at: the key the list and the feed sort on.
    expect(r).toEqual({ at: "2026-11-01T00:00:00Z", editor: "Priya Raman via mkt-amplifier" });
  });

  it("Given no updated_at, then the time falls back to the version's edited_at", () => {
    const r = rowLastEdit({ last_edit: { edited_by: "priya@larkspur.example", edited_at: "2026-11-02T00:00:00Z" } }, people);
    expect(r?.at).toBe("2026-11-02T00:00:00Z");
  });

  it("Given no agent, then it reads as the human alone", () => {
    const r = rowLastEdit({ last_edit: { edited_by: "priya@larkspur.example", edited_at: "2026-11-02T00:00:00Z" } }, people);
    expect(r?.editor).toBe("Priya Raman");
  });

  it("Given no last_edit (a public reader), then it keeps the time and names nobody", () => {
    expect(rowLastEdit({ updated_at: "2026-11-01T00:00:00Z" }, people)).toEqual({ at: "2026-11-01T00:00:00Z", editor: null });
  });

  it("Given neither a time nor an editor, then there is nothing to show", () => {
    expect(rowLastEdit({}, people)).toBeNull();
  });
});
