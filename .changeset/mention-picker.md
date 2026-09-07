---
"@promptowl/contextnest-community": minor
---

`@mention` now picks a real person.

Typing `@` in a document opens the same autocomplete `[[` uses, listing everyone who can reach the nest, and picking one writes their address into the text. An `@name` matching nobody on the nest is drawn muted and dashed with a "no member named X" tooltip, the same way a broken `[[wiki link]]` is, so a typed name is no longer indistinguishable from a real reference.

"Everyone who can reach the nest" is a wider set than the collaborator roster: the owner, the members of a team the nest is shared with, stewards, and holders of a document or folder grant all reach a nest without holding a collaborator row. `GET /nests/:id/collaborators` now returns that union alongside the roster as `people`, each entry carrying the path that lets them in. The roster itself, and the Collaborators tab that manages it, are unchanged.

Being mentioned now tells you. Saving a document drops an inbox row — the same place review requests and invites land — for everyone the save newly names: "someone mentioned you in "Doc"", opening straight to the document. Only new names notify, so the same mention surviving a dozen saves is one event; a name matching nobody notifies nobody; authors don't hear about mentioning themselves; and a mention only reaches someone who can actually open the document.
