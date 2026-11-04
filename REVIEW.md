# REVIEW.md

Instructions for every code review of this repository — the Claude PR review workflow, the managed Claude Code Review, and human reviewers alike.

## Required PR checklist (always blocking)

Check these on **every** PR before reviewing code. Read the PR title, body and branch name (`gh pr view <number> --json title,body,headRefName`). A missing item is a 🔴 **blocking** finding — never a nit, never optional, whoever (or whatever) wrote the PR.

1. **Ticket.** The PR references the ticket the work belongs to. Tickets live in the Engineering Ops nest: the standard reference is a `Task:` line (by convention the first line of the body) linking a task node, e.g. `Task: https://nest.promptowl.ai/nest/<nest-id>?doc=nodes/projects/<stage>/<task-slug>`. A rollup PR has one `Task:` line per ticket. A branch named `<first>-<last>/<task-slug>` or a `[<task-slug>]` commit subject points at the same task. During the move off ClickUp, a ClickUp reference is still accepted: `CU-<id>`, `[CU-<id>]`, `#<id>`, or an `app.clickup.com/t/<id>` link. No reference of either kind → 🔴 blocking.
2. **Steps to test.** The PR body has a section titled "Steps to test" (or "How to test" / "Testing steps") with numbered steps a tester can follow **from the user's perspective**:
   - where to go or what to run (page, command, API call, starting data),
   - what to do,
   - what they should see when it works (and, for a bug fix, what they saw before).

   🔴 blocking when the section is missing, when it is only "ran unit tests" / "CI passes", or when the steps do not exercise the change in the diff. A PR with no user-facing change (docs, CI, refactor, chore) may say `N/A — no user-facing change` plus one line on why; the reviewer must agree with that claim.

Start the review comment with this block, then the code findings:

```
### PR checklist
- ✅/🔴 Ticket: <Engineering Ops Task link or ClickUp id found, or "missing">
- ✅/🔴 Steps to test: <ok, or what is missing>
```

## Code review focus

- Correctness bugs, security, performance, and missing or weak tests for new behaviour.
- The rules in `CLAUDE.md`. A finding that cites a CLAUDE.md rule is not optional.
- Report problems only; skip praise.

### This repo

- Engine logic boundary: core engine logic (versioning, hashing, prompt compilation) belongs upstream in `PromptOwl/ContextNest`, not here.
- No new inline `inputSchema` literals in `src/mcp/`; canonical `context_*` naming and governance vocabulary only.
- App pages follow the `ui/src/pages/app/<slug>/` (`meta.ts` + `page.tsx`) pattern.