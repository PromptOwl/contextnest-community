---
title: Experiment rules
---
# Experiment rules

These rules keep the loop honest. An experiment that breaks one is a defect.

## Before it starts (pre-registration)
Write the experiment document, and get it approved, with:
1. **The hypothesis** it tests, linked.
2. **The funnel stage** it should move.
3. **The primary metric**, one we trust, and its **baseline** today.
4. **The smallest effect** worth acting on, or "directional only" when volume is too low to say more.
5. **The duration.**
6. **The decision rule:** the result at which we kill it, iterate on it, or scale it.
7. **The units to ship** and the people-hours they cost.

## While it runs
- At most **three** experiments live at once.
- The decision rule does not change mid-flight. A new idea is a new experiment.

## When it ends
- Read the metric, apply the rule as written, and record the verdict as a learning: won, lost or inconclusive, with the effect and how sure we are.
- A play that wins **twice** with a consistent effect becomes a playbook.
- An experiment whose planned units never shipped ends "not tested". That is a defect, not a result.
