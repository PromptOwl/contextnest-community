---
"@promptowl/contextnest-community": patch
---

Fix the "Add a person" field's suggestion dropdown reopening with an empty
query (listing every server account) after adding a collaborator by pressing
Enter. The list now closes as soon as Enter submits the typed address,
instead of staying open and re-querying once the field cleared.
