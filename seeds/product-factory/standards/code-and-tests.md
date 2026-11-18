---
title: Standard - code and tests
---
# Standard: code and tests (stage 6)

1. **Tests first.** Turn each acceptance criterion into a failing test, then make it pass. Keep the red and the green output.
2. **Small and readable.** Reuse what the codebase already has before adding something new. No dead code, no unused options.
3. **Safe by default.** Validate input at the edge, escape output, never log secrets, check permissions on every read and write.
4. **No surprise dependencies.** A new dependency needs a reason in the PR.
5. **Run it.** Run the tests and the app in an isolated environment before saying it works. Paste the output.

On a build loop, address every fix the evaluation listed, and say how.
