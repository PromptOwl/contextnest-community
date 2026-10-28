---
"@promptowl/contextnest-community": minor
---

Table nodes can link rows into the graph. Mark a column `:ref` in the header (`id:key,account:ref,amount:number`) and fill it with `[[Title]]`, `[[path|label]]` or a node id. Each filled cell becomes an edge named after the column, from the table to that document, credited to the row: the graph shows it, the target's backlinks read "Pipeline · account · r1", and `where account = [[AGA]]` finds every row pointing at AGA however the cell spells it. A ref to a document that doesn't exist still saves; the save response lists it as unresolved. A document you can't read never shows up through a ref.
