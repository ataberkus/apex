# Verified illustrative API pricing

Retrieved **2026-10-01T00:24:09Z** from official pricing and model pages. The accompanying `evals/pricing.json` is a small reference registry, not a default or selected production model list. Research made no model inference calls and incurred no provider usage charges.

All amounts below are **USD per million tokens**. These are standard API token prices with the context bands stated below; they do not imply free-account access. Pi-compatible provider identifiers are `anthropic`, `openai`, and `google`.

| Provider | Exact API ID | Input | Cache read | Cache write | 1-hour write | Output | Scope |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| anthropic | `claude-opus-5-5` | 4 | 0.20 | 5 | 8 | 20 | Standard global; supported 1M context |
| anthropic | `claude-sonnet-5-5` | 2 | 0.20 | 2.50 | 4 | 10 | Standard global; supported 1M context |
| anthropic | `claude-haiku-4-5-20251001` | 1 | 0.10 | 1.25 | 2 | 5 | Standard; supported 200K context |
| openai | `gpt-6.1-sol` | 2 | 0.10 | 2.50 | — | 10 | Standard text; input prompt ≤272K |
| openai | `gpt-6-luna` | 0.10 | 0.01 | 0.125 | — | 0.50 | Standard text; input prompt ≤272K |
| google | `gemini-3.5-flash-lite` | 0.30 | 0.03 | unknown | — | 2.50 | Developer API paid Standard; no listed context-price split |
| google | `gemini-2.5-pro` | 1.25 | 0.125 | unknown | — | 10 | Developer API paid Standard; prompt ≤200K |

Anthropic's `cache_write` means its **5-minute** cache-write rate; `cache_write_1h` records the separately published 1-hour rate. Haiku uses the pinned ID verified by its model page; `claude-haiku-4-5` is its documented alias.

OpenAI publishes cache-write rates directly. They are an input category, not an extra charge added to the same tokens' normal input price. Its optional `cache_write_1h` field is omitted because the checked pages do not publish a distinct 1-hour rate. See the official [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

Google does not publish a separate per-token cache-write rate in these tables. The registry uses `null`, meaning **unknown**, rather than inventing zero or reusing another rate. Google output rates include thinking tokens. Flash-Lite's published input price covers text, image, video, and audio; its model page lists a 1,048,576-token input limit.

## Longer-context bands

The JSON has one scoped row per API ID; it does not automatically select another price band. A calculator must inspect the prompt band before using these values.

| Exact API ID | Trigger | Input | Cache read | Cache write | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| `gpt-6.1-sol` | Input prompt >272K tokens | 4 | 0.20 | 5 | 15 |
| `gpt-6-luna` | Input prompt >272K tokens | 0.20 | 0.02 | 0.25 | 0.75 |
| `gemini-2.5-pro` | Prompt >200K tokens | 2.50 | 0.25 | unknown | 15 |

OpenAI explicitly applies its longer-context rates to the **full request**. Google presents separate prompt-size bands. The checked Anthropic pages list unchanged token rates through each model's supported context.

## Cache storage and exclusions

Google explicit cache storage is billed separately: **$1 per million cached tokens per hour** for Gemini 3.5 Flash-Lite and **$4.50 per million cached tokens per hour** for Gemini 2.5 Pro. This hourly unit cannot be represented by a per-million-token cache-write value. Storage estimate: `cached_tokens / 1_000_000 × retained_hours × hourly_rate`; actual retention and billing follow the provider's rules. See the [context caching guide](https://ai.google.dev/gemini-api/docs/caching).

Gemini 2.5 Pro is retained here as an example of context-dependent prices. Its official model page limits access to prior active Gemini 2.5 users and says it is not deprecated. This row does not establish eligibility for a new project.

Rows exclude Batch, Flex, Fast/Priority modes, regional uplifts, free-tier terms, subscriptions, negotiated discounts, taxes, and tool-specific fees. They are a dated snapshot; refresh the official tables before any paid evaluation. No cache-write omission or `null` should be interpreted as a zero cost.

## Primary sources

Pricing:

- [Anthropic Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Google Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)

API identity and model-specific scope:

- [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- [Claude Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
- [Claude Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Gemini 2.5 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)
