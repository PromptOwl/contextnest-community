---
"@promptowl/contextnest-community": patch
---

In the Fields tab, removing the option a Select field uses as its Default value now sets Default value back to None, as changing the Type already does. Before, the box went blank while the form kept the removed option, and Add field failed with an error about a value nobody could see.
