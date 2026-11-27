---
title: Runbook (start here)
---
# Runbook: the eight-stage product pipeline

Read this first. It tells each stage what to read, what to write and when to stop.

## The one rule: isolation

Each stage reads only the goal, its one standard and the artifacts handed to it. It never reads the whole nest. A stage that needs "a bit more context" is a sign the goal is unclear: stop and ask.

## The stages

| # | Stage | Standard | Reads | Writes |
|---|---|---|---|---|
| 1 | Intent | product-brief | the goal | need |
| 2 | Red team | product-brief | need | need, with the risks and holes named |
| 3 | Design | design-review | need (and the design review, on a loop) | a clickable prototype |
| 4 | Design review | design-review | need, prototype | design review, ending DESIGN_APPROVED yes or no |
| 5 | PRD | prd | need, prototype, design review | PRD with acceptance criteria |
| 6 | Build | code-and-tests | PRD, need, prototype (and the evaluation, on a loop) | the code and its tests |
| 7 | Smoke and eval | evaluation | the build's test output, PRD, need | evaluation, ending OBJECTIVES_MET yes or no |
| 8 | Retro | none | the run's notes | a retro document, and proposed changes to a standard |

## The two loops

- **Design loop (3 and 4):** until DESIGN_APPROVED is yes. At most two rounds.
- **Build loop (6 and 7):** until OBJECTIVES_MET is yes. At most two rounds.

A reviewer hands back concrete fixes. A third round means the goal is wrong: go back to Intent.

## On the board and in chat

Each feature is a task on the Build pipeline board, tagged with its stage. When a stage finishes, move the task to the next stage and post the output in the feature's #builds thread. A gate (DESIGN_APPROVED, OBJECTIVES_MET) is a person's approval in that thread.

## Evidence before claims

A stage is done only with its output: files, test counts, command output. "Looks good" is not status.
