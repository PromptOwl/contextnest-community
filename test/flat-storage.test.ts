import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Emulate a write finishing mid-crawl: the engine's lock folder
// (.versions/.lock) is gone by the time the walk reaches it, which a recursive
// readdir reports as ENOENT for the whole listing.
vi.mock("fs/promises", async (orig) => {
  const real = await orig<typeof import("fs/promises")>();
  return {
    ...real,
    readdir: (path: any, opts: any) => {
      if (opts?.recursive || String(path).includes(".versions")) {
        const err: any = new Error(`ENOENT: scandir '${join(String(path), ".versions", ".lock")}'`);
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      return (real.readdir as any)(path, opts);
    },
  };
});

const { FlatNestStorage } = await import("../src/nodes/flat-storage.js");

const doc = (title: string) => `---\ntitle: ${title}\ntype: document\n---\n\n# ${title}\n`;

describe("FlatNestStorage.discoverDocuments", () => {
  it("finds nested docs and never walks into hidden dirs like .versions/.lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "flat-storage-"));
    mkdirSync(join(root, "topic", "sub"), { recursive: true });
    mkdirSync(join(root, ".versions", ".lock"), { recursive: true });
    writeFileSync(join(root, "readme-doc.md"), doc("Root"));
    writeFileSync(join(root, "topic", "sub", "deep.md"), doc("Deep"));
    writeFileSync(join(root, ".versions", "hidden.md"), doc("Hidden"));

    const docs = await new FlatNestStorage(root).discoverDocuments();

    expect(docs.map((d) => d.id)).toEqual(["readme-doc", "topic/sub/deep"]);
  });
});
