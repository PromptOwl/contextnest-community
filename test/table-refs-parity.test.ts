/**
 * ui/src/lib/table-refs.ts mirrors the server's ref parsing and resolution.
 * Same inputs through both must give the same refs and targets, so the
 * backlinks panel never drifts from the graph and table query.
 */
import { describe, it, expect } from "vitest";
import { extractTableRefs, parseTable } from "../src/tables/service.js";
import { makeRefResolver } from "../src/tables/refs.js";
import {
  extractTableRefs as uiExtractTableRefs,
  makeRefResolver as uiMakeRefResolver,
} from "../ui/src/lib/table-refs";

const CASES: Record<string, string> = {
  key: "id:key,account:ref\nr1,[[AGA]]\nr2,\nr3,[[nodes/aga|Acme]]",
  "blank key and no key": "id:key,a:ref\n,[[X]]\nr2,[[Y]]",
  "no key column": "a:ref,n:number\n[[X]],1\nnodes/y,2",
  "bare ids": "id:key,a:ref\nr1,nodes/aga\nr2,  nodes/b  ",
  quoting: 'id:key,a:ref,note\n"r,1","[[A, B]]","say ""hi"""\nr2,"nodes/c",x',
  comments: "# header comment\nid:key,a:ref\n\n# row comment\nr1,[[X]]",
  "two ref columns and combined directives": "deal:key:ref,owner:ref\n[[D1]],[[Jane]]\n[[D2]],",
  "empty [[ ]]": "id:key,a:ref\nr1,[[ ]]\nr2,[[|label]]",
};

describe("UI table-refs mirrors the server parser", () => {
  for (const [name, body] of Object.entries(CASES)) {
    it(name, () => {
      expect(uiExtractTableRefs(body)).toEqual(extractTableRefs(parseTable(body)));
    });
  }
});

describe("UI resolver mirrors the server resolver", () => {
  const docs = [
    { id: "nodes/accounts/aga-corp", title: "AGA" },
    { id: "nodes/old/aga", title: "Old" },
    { id: "nodes/dup-1", title: "Dup" },
    { id: "nodes/dup-2", title: "dup" },
  ];
  const server = makeRefResolver(docs.map((d) => ({ id: d.id, frontmatter: { title: d.title } as any })));
  const ui = uiMakeRefResolver(docs);
  const probes: Array<[string, boolean]> = [
    ["AGA", false], ["aga", false], ["nodes/old/aga", false], ["nodes/old/aga", true],
    ["old/aga", true], ["Dup", false], ["missing", false], [" nodes/dup-2 ", true], ["", false],
  ];
  for (const [target, bare] of probes) {
    it(`${JSON.stringify(target)} bare=${bare}`, () => {
      expect(ui(target, bare)).toBe(server(target, bare));
    });
  }
});
