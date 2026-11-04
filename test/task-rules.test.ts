/**
 * Task rules (src/nodes/task-rules.ts): exclusive tag namespaces, the default
 * stage tag, and ticket-number prefixes. Pure — no nest, no database.
 */
import { describe, it, expect } from "vitest";
import {
  applyExclusiveNamespaces,
  cleanTaskRules,
  formatTicket,
  parseTaskRules,
  surfaceFor,
  tagNamespace,
  ticketFromTag,
  ticketPrefixOf,
  defaultTicketPrefix,
  ticketTag,
  ticketTagOf,
} from "../src/nodes/task-rules.js";

describe("tagNamespace", () => {
  it("reads the part before the colon, ignoring # and case", () => {
    expect(tagNamespace("#Stage:Done")).toBe("stage");
    expect(tagNamespace("ticket:cn-12")).toBe("ticket");
  });
  it("is null for a plain tag or a dangling colon", () => {
    expect(tagNamespace("#community")).toBeNull();
    expect(tagNamespace("#stage:")).toBeNull();
    expect(tagNamespace("#:done")).toBeNull();
  });
});

describe("applyExclusiveNamespaces", () => {
  const ns = ["stage"];

  it("adding a new stage replaces the old one", () => {
    const r = applyExclusiveNamespaces(
      ["#stage:backlog", "#community"],
      ["#stage:backlog", "#community", "#stage:in-review"],
      ns,
    );
    expect(r.tags).toEqual(["#community", "#stage:in-review"]);
    expect(r.dropped).toEqual(["stage:backlog"]);
    expect(r.ambiguous).toEqual([]);
  });

  it("leaves a set with one stage alone", () => {
    const next = ["#stage:done", "#theowl"];
    expect(applyExclusiveNamespaces(["#stage:done"], next, ns).tags).toEqual(next);
  });

  it("does nothing when no namespaces are configured", () => {
    const next = ["#stage:a", "#stage:b"];
    expect(applyExclusiveNamespaces([], next, []).tags).toEqual(next);
  });

  it("flags two NEW tags in one namespace as ambiguous and keeps the last", () => {
    const r = applyExclusiveNamespaces([], ["#stage:backlog", "#stage:done"], ns);
    expect(r.ambiguous).toEqual(["stage"]);
    expect(r.tags).toEqual(["#stage:done"]);
  });

  it("repairs a node that already holds two by keeping the last listed", () => {
    const r = applyExclusiveNamespaces(
      ["#stage:backlog", "#stage:done"],
      ["#stage:backlog", "#stage:done"],
      ns,
    );
    expect(r.tags).toEqual(["#stage:done"]);
    expect(r.ambiguous).toEqual([]);
  });

  it("only touches the listed namespaces", () => {
    const r = applyExclusiveNamespaces([], ["#area:a", "#area:b", "#stage:x"], ns);
    expect(r.tags).toEqual(["#area:a", "#area:b", "#stage:x"]);
  });
});

describe("tickets", () => {
  it("formats and round-trips through the tag", () => {
    expect(formatTicket("CMN", 7)).toBe("CMN-7");
    expect(ticketTag("CMN-7")).toBe("#ticket:cmn-7");
    expect(ticketFromTag("#ticket:cmn-7")).toBe("CMN-7");
    expect(ticketFromTag("#stage:done")).toBeNull();
    expect(ticketFromTag("#ticket:nonsense")).toBeNull();
  });

  it("finds a task's ticket tag", () => {
    expect(ticketTagOf(["#community", "#ticket:cn-3"])).toBe("ticket:cn-3");
    expect(ticketTagOf(["#community"])).toBeNull();
  });

  const SURFACES = [
    { name: "Community Nest", tags: ["community"] },
    { name: "Core", tags: ["contextnest", "engine"] },
  ];

  it("the prefix is the nest's, not the surface's", () => {
    const rules = cleanTaskRules({ surfaces: SURFACES, ticket_numbering: true, ticket_prefix: "po" });
    expect(rules.ticket_prefix).toBe("PO");
    expect(ticketPrefixOf(rules)).toBe("PO");
    expect(ticketPrefixOf(cleanTaskRules({ ticket_prefix: "PO" }))).toBeNull(); // numbering off
  });

  it("a task is in the first surface (in the nest's order) whose tag it carries", () => {
    const rules = cleanTaskRules({ surfaces: SURFACES });
    expect(surfaceFor(["#engineering", "#community"], rules)?.name).toBe("Community Nest");
    expect(surfaceFor(["#engine"], rules)?.name).toBe("Core");
    expect(surfaceFor(["#contextnest", "#community"], rules)?.name).toBe("Community Nest");
    expect(surfaceFor(["#engineering"], rules)).toBeNull();
  });

  it("default_surface names a surface and nothing else", () => {
    const rules = cleanTaskRules({ surfaces: SURFACES, default_surface: "core" });
    expect(rules.default_surface).toBe("Core");
    expect(surfaceFor(["#engineering"], rules)).toBeNull();
  });
});

describe("cleanTaskRules", () => {
  const surface = (o: Record<string, unknown> = {}) => ({
    name: "Community Nest",
    tags: ["community"],
    ...o,
  });

  it("refuses unknown fields and bad shapes by name", () => {
    expect(() => cleanTaskRules({ nope: 1 })).toThrow(/unknown field/);
    expect(() => cleanTaskRules("x")).toThrow(/must be an object/);
    expect(() => cleanTaskRules({ exclusive_namespaces: ["bad ns"] })).toThrow(/namespace/);
    expect(() => cleanTaskRules({ ticket_numbering: "yes" })).toThrow(/true or false/);
    expect(() => cleanTaskRules({ surfaces: "x" })).toThrow(/list of/);
  });

  it("validates each surface and says which one is wrong", () => {
    expect(() => cleanTaskRules({ surfaces: [surface({ name: "" })] })).toThrow(/needs a name/);
    expect(() => cleanTaskRules({ ticket_prefix: "c" })).toThrow(/2–6 capital/);
    expect(() => cleanTaskRules({ ticket_prefix: "1AB" })).toThrow(/2–6 capital/);
    expect(() => cleanTaskRules({ ticket_numbering: true })).toThrow(/ticket_prefix/);
    expect(() => cleanTaskRules({ ticket_start_at: 0 })).toThrow(/ticket_start_at/);
    expect(() => cleanTaskRules({ surfaces: [surface({ tags: [] })] })).toThrow(/at least one valid tag/);
    expect(() => cleanTaskRules({ surfaces: [surface(), surface()] })).toThrow(/two surfaces are named/);
    expect(() => cleanTaskRules({ surfaces: [surface()], default_surface: "Nope" })).toThrow(/not one of the surfaces/);
  });

  it("normalises namespaces, the default stage, prefixes and tags", () => {
    const r = cleanTaskRules({
      exclusive_namespaces: ["Stage", "#stage:", "owner"],
      default_stage_tag: "#Stage:Backlog",
      ticket_prefix: "po",
      surfaces: [surface({ tags: ["#Community", "community", "Comm"] })],
    });
    expect(r.exclusive_namespaces).toEqual(["stage", "owner"]);
    expect(r.default_stage_tag).toBe("stage:backlog");
    expect(r.ticket_prefix).toBe("PO");
    expect(r.surfaces).toEqual([{ name: "Community Nest", tags: ["community", "comm"] }]);
  });

  it("stored garbage reads as off instead of throwing", () => {
    expect(parseTaskRules("not json").ticket_numbering).toBe(false);
    // Numbering with no prefix reads back as off.
    expect(parseTaskRules('{"ticket_numbering": true}').ticket_numbering).toBe(false);
    expect(parseTaskRules(null).exclusive_namespaces).toEqual([]);
    expect(parseTaskRules('{"surfaces": 5}').surfaces).toEqual([]);
    // A bad entry is dropped on read; the good ones still work.
    expect(
      parseTaskRules(JSON.stringify({ surfaces: [{ name: "" }, surface()] })).surfaces,
    ).toHaveLength(1);
  });
});

describe("defaultTicketPrefix", () => {
  it("takes a leading acronym, else initials, else letters, else TASK", () => {
    expect(defaultTicketPrefix("PO - Engineering Ops")).toBe("PO");
    expect(defaultTicketPrefix("Community Nest")).toBe("CN");
    expect(defaultTicketPrefix("contextnest-community")).toBe("CC");
    expect(defaultTicketPrefix("Engineering")).toBe("ENG");
    expect(defaultTicketPrefix("")).toBe("TASK");
    expect(defaultTicketPrefix("日本語")).toBe("TASK");
  });

  it("always yields a prefix the settings accept", () => {
    for (const name of ["PO - Engineering Ops", "x", "A B C D E F", "9 lives", "The Quick Brown Fox Jumps"]) {
      expect(() => cleanTaskRules({ ticket_prefix: defaultTicketPrefix(name) })).not.toThrow();
    }
  });
});
