/**
 * Review round 1 (🔴): the rows endpoint must never apply ops to a body older
 * than the head version it hands to updateNode as expectHead. readStable reads
 * head → body → head and only returns when both head reads agree.
 */
import { describe, it, expect } from "vitest";
import { readStable } from "../src/tables/row-routes.js";

describe("readStable", () => {
  it("a write landing between the body read and the head read is not missed", async () => {
    // Body v5 is read, then B commits v6 before the head is read.
    let head = 5;
    let body = "v5";
    const out = readStable(
      async () => head,
      async () => {
        const b = body;
        head = 6;
        body = "v6";
        return b;
      },
    );
    // Whatever it returns, the body must belong to the head it reports.
    const r = await out.catch((e) => e);
    if (r instanceof Error) {
      expect(r.message).toMatch(/changed/);
    } else {
      expect(r).toEqual({ head: 6, body: "v6" });
    }
  });

  it("returns the pair when nothing moves", async () => {
    expect(await readStable(async () => 3, async () => "b3")).toEqual({ head: 3, body: "b3" });
  });

  it("gives up after repeated movement", async () => {
    let h = 0;
    await expect(readStable(async () => h++, async () => "x")).rejects.toThrow(/changed/);
  });
});
