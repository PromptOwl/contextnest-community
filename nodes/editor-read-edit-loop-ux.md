---
type: document
title: Doc editor read↔edit loop: Done button + visible autosave status
tags: [community, improvement, developer, convention, feedback]
---

# Making the doc editor easier to use

User feedback (2026-06-26): "it's really hard to use." The friction was all in
one place — the read/edit loop in `DocumentEditor.tsx`:

- Docs opened straight into the editor (fixed earlier — see
  [[doc-opens-in-view-mode-fix]]).
- In edit mode the only exit was the back-arrow, which left the doc entirely;
  there was no "return to reading" affordance.
- "Save" both wrote *and* navigated to the nest list, while a silent autosave
  ran invisibly — so users couldn't tell if their work was safe ("all I have
  is save").

## Changes

1. **"Done" replaces "Save" on existing docs.** It flushes the save and drops
   back to the rendered reading view *in place* (`setMode("view")`), instead of
   bouncing to the nest list. Core loop is now read → Start Editing / dblclick →
   edit → Done → read. New docs keep the "Create" button + navigate-on-create.
   `handleDone` skips the write when `!isDirty` so opening/closing the editor
   never churns a spurious version.
2. **Visible autosave status** next to the button in edit mode:
   "Saving… / Unsaved — autosaves / All changes saved" — derived from existing
   `saving` + `isDirty`, no new state. Makes the deliberately-silent autosave
   legible so the page never feels like it might lose work.

## Convention

The editor's autosave is intentionally silent (no spinner) to avoid flicker,
but silence reads as "did it save?" Surface a lightweight text status rather
than re-introducing spinners. Keep the read view the resting state; editing is
a mode you enter and explicitly leave via Done.
