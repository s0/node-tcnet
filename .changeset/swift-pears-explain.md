---
"@s0/node-tcnet": minor
---

Always emit data and broadcast events

Ensure that data and broadcast packets are always accessible to listeners,
even when the library hasn't added specific handling for it,
or when we're receiving packets that aren't part of a request we've made.