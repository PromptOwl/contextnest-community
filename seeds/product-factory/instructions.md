---
title: Nest instructions
---
# How this nest is organised

This nest runs a product pipeline. Work moves through eight stages, each with one standard and one output, and two capped review loops.

- **runbook**: start here. The stages, what each one reads and writes, and the two loops.
- **specs/**: one folder of documents per feature: the goal, the need, the design review, the PRD and the evaluation.
- **standards/**: the rulebooks the stages follow. Change them through review, never silently.
- **decisions/**: agreed choices, one per document, with who decided and why.
- **retros/**: what each run taught us and the change it makes to a standard.
- **agents/**: saved agents. Only nest admins can approve changes here.

Every feature is a task on the **Build pipeline** board. Move it by changing its stage tag. If team chat is on, each feature also has a thread in #builds where the stages post their output.

For agents: read the runbook first, then only the standard and the artifacts your stage is given. Do not read the whole nest.
