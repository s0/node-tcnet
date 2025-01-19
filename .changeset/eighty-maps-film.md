---
"@s0/node-tcnet": minor
---

Make shutdown return a Promise

More cleanly wait for the client's connections to shut-down by returning a
promise that only resolves once the connection is closed.
