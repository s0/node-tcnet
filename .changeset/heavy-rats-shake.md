---
"@s0/node-tcnet": minor
---

Remove pioneer module

Removing the pioneer module and related exports as package should remain
vendor-agnostic,
and we don't want to keep this module maintained with the more
disruptive changes we're making.
