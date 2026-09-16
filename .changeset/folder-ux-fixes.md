---
"@promptowl/contextnest-community": patch
---

Three folder fixes in the nest view.

**New Document lands in the folder you're looking at.** With the Documents tab scoped to a folder, the header's New Document button always filed the document under the nest root. It now defaults to that folder; the editor's folder picker still lets you change it.

**Folder names keep their casing in the New Document picker.** The create-form breadcrumb and subfolder list rendered the raw storage slug (`a`) while every other surface showed `A`. They now use the same display name.

**Empty folders show on the Overview.** The Contents card hid the folder tree until the nest had at least one document, so folders created first were invisible even though the folder count had moved.
