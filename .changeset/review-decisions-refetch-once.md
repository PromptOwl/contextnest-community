---
"@promptowl/contextnest-community": patch
---

Approving or sending back several documents in a row no longer makes the review screen re-read the whole nest after every click. The first decision still updates the screen straight away. The ones that follow share a single refresh a couple of seconds later, so a reviewer clearing a queue sends a fraction of the requests and is far less likely to hit "Rate exceeded."
