---
"@promptowl/contextnest-community": patch
---

Board due dates: typing a year into the due-date picker no longer saves a half-typed year such as 0020 after the first two digits. The server now refuses due dates before 1900 or days that don't exist, and an existing bad date displays as its real year instead of 1920.
