---
"@dm-hero/app": patch
---

Filter unsafe HTML in all markdown previews: scripts, event handlers and `javascript:` links from imported adventures or AI agents no longer run. Raw HTML in existing notes loses its `style`, `class` and `align` attributes; plain markdown, entity badges, images and tables are unchanged.
