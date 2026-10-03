---
"@dm-hero/app": patch
---

Fix random Docker crashes (`RemoveEnvironmentCleanupHook` assertion) by pinning the image to Node 24.18.0 until Node fixes its 24.19+ regression.
