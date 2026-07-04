---
type: document
title: Docs must open in rendered view, not edit (DocumentEditor buttery-editor auto-flip)
tags: [community, bug, gotcha, developer, convention]
---

# Docs open in rendered view, double-click to edit

**Symptom (dogfood, 2026-06-26):** opening any node in the community UI dropped
straight into the TipTap editor — impossible to *read* the doc.

## Why

`ui/src/components/DocumentEditor.tsx` already has the right machinery:

- `mode` state defaults to `view` for existing docs, `edit` for new
  (`isNew ? "edit" : "view"`).
- `view` mode renders `DocumentViewer` (react-markdown reader); the header
  shows a **Start Editing** button; double-clicking the body enters edit.

But a "buttery editor" `useEffect` auto-flipped any user who *could* edit
(owner/editor — not view-only/locked/reviewer) from `view → edit` on mount.
For a nest owner that's every doc, so the read view was never seen. The
content container also used single `onClick` to enter edit (despite the
"Dblclick → edit" comment), so reading + text selection flipped to edit.

## Fix

1. **Deleted the auto-flip effect.** Existing docs now stay in `view`; new
   docs still start in `edit` via the initial `mode` state. No remount cost
   concern in practice — reading-first is the product invariant
   (nodes are immutable markdown; editing is an explicit action).
2. **`onClick` → `onDoubleClick`** on the content container so single-click
   selects text and double-click (or the Start Editing button) edits.

**Convention:** read-first is the intended UX for this reader. Don't
auto-enter edit mode for editable users — surface an explicit affordance
instead. The unused-looking `DocumentViewer` IS the read path; keep it wired.
