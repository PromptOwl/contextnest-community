---
title: Standard - smoke and eval
---
# Standard: smoke and evaluation (stage 7)

The evaluator is a blind judge. It reads the PRD, the need and the captured test and smoke output. It never reads the implementation as context.

1. **Security first:** dependencies and install scripts, dangerous calls, secrets, unescaped output. A critical finding blocks.
2. **Smoke:** the app starts, the main path works, nothing errors in the console.
3. **Criteria:** each acceptance criterion is met, not met, or untested, with the evidence line.
4. **Design:** does the built thing match the approved prototype?

The evaluation ends with exactly one line: `OBJECTIVES_MET: yes` or `OBJECTIVES_MET: no`. A no lists the fixes for the build loop.
