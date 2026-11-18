---
"@promptowl/contextnest-community": patch
---

Adding a second `ticket:` tag to a numbered task (for example `ticket:qa-99` on QA-2) is now refused with "This task is QA-2. Ticket numbers are assigned once and can't be changed." Before, the server dropped the tag without saying so and the editor reported "Tag added. Saved.", then the tag was gone after a reload. The editor now shows the server's reason and takes the tag back off.
