# AI providers

One router (`src/ai_router.js`) sits behind `complete()` in `src/ai.js`. All six providers are reached through their documented **OpenAI-compatible HTTP API** (no vendor SDKs; Gemini is used through Google's OpenAI-compatibility endpoint, not the native API).

| Provider | Base URL used | Env var | JSON mode sent |
|---|---|---|---|
| Google Gemini (AI Studio) | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` | no (prompt-only; answer is validated) |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `json_object` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `json_object` |
| Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | no |
| Mistral AI | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `json_object` |
| Requesty | `https://router.requesty.ai/v1` | `REQUESTY_API_KEY` | no |

Several keys: `GROQ_API_KEY=key1,key2` (environment) or add them in Admin → AI providers (stored AES-256-GCM with `TOKEN_KEY`). Several keys do **not** add quota when they belong to one account/project; use only keys you are entitled to.

## What was checked against provider documentation (during implementation)
- Groq: `retry-after` (seconds) and `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` headers (reset as durations such as `2m59.56s`). Parsed as documented.
- Gemini: OpenAI-compatible base URL and `Authorization: Bearer` confirmed. **Not confirmed:** `response_format` for chat on that endpoint, so none is sent.
- Mistral: `POST /v1/chat/completions`, Bearer auth, `response_format: {"type":"json_object"}`.
- Requesty: base URL `https://router.requesty.ai/v1`, OpenAI client with `base_url`.
- Cerebras: its docs describe a **credit-bounded free trial ($5, expires after 30 days), not a permanent free tier**; `json_schema` response format exists. The base URL above was not on the pages read; confirm in your console.

## NOT verified (needs the account owner)
No real request was made to any provider; no accounts were available. Therefore **no model id is preloaded or claimed free.** For each provider: add the model id exactly as your own account lists it (the *Test connection* button lists the models your key can see), then tick "free" only if your plan makes it free. Still to verify yourself: current free quotas, whether free-tier prompts/outputs may be used to train models (Google AI Studio free tier, Mistral free/experiment plan and OpenRouter free models have historically had such terms - check the current ones, and avoid free routes if that is unacceptable for source material), data retention, regional restrictions, and each provider's terms for automated news use.

## Behaviour
- Candidate = enabled provider + enabled model + usable key, not cooling down, inside daily request/token budgets, allowed by free-only mode and the daily spending cap, suitable for the language and output size. Order: model priority, least-recently-used key.
- 401/403: key rests 6 h. 402: key rests 1 h. Model-not-found: model rests 6 h. 429: key rests for at least `Retry-After`/reset header, otherwise exponential backoff with jitter (30 s → 15 min). 5xx/timeout/network: model rests (15 s → 10 min). Rest means **no calls**, not retries; failover goes to another provider/key, never to the same one.
- Quota fields come only from response headers; absent = **unknown**, shown as such. Unknown-price calls count `unknown_call_cost_usd` ($0.01) toward the cap.
- Nothing available: the edition job stays queued with `run_at` = earliest time capacity returns and **no attempt is burned**; it resumes by itself.
- Validated answers are cached by `sha256(task, lang, system, user)`; retries reuse them (no second charge, no duplicate article). Invalid answers are never cached.
- Free-only mode and the cap apply to the original single OpenRouter configuration too (it counts as paid). With no provider enabled in the admin, the original path is used unchanged.
- Calls per story: one request per edition (+1 rewrite only when the copy check demands it). A single request for both editions was **not** adopted or measured: it would make one edition derive from the other, which the editorial rules forbid.
