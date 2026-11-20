---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

The SDK no longer sends each approved query's `EmbeddingVector` to Skip. Skip never read it (it embeds queries itself), and on More Cheese it was about 750,000 characters of every request. `EmbeddingModelID` and `EmbeddingModelName` are still sent.
