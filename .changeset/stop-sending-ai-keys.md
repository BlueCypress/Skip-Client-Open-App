---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

**Security:** the SDK no longer sends the host's AI provider keys to Skip. Every chat request carried the MJAPI's OpenAI, Anthropic, Gemini, Groq, Mistral and Cerebras keys in `apiKeys`; Skip never used them (it runs each request with the organization's own credentials, stored in Skip). `SkipAPIRequest.apiKeys` and `SkipAPILearningCycleRequest.apiKeys` are now optional and deprecated. Works with every Skip Brain version: none read the field.
