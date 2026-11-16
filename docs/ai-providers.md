# AI providers

AI is **optional and off by default**. Without it, git-merge-pilot still produces full reports from deterministic analysis: breaking changes, security rules and scanners, overlap, risk scores and merge readiness. AI adds a narrative summary and business-impact explanation, potential concerns, and semantic overlap (duplicate work) detection.

An admin enables AI in the setup wizard (step 4) or under **Settings → AI**. They must first view the data-flow screen. Their consent is recorded with the user and a timestamp.

## Provider types

There are two adapter kinds.

| Kind                | SDK                                                 | Covers                                                                                                          |
| ------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `anthropic`         | official `@anthropic-ai/sdk`                        | Anthropic API                                                                                                   |
| `openai_compatible` | official `openai` SDK with a configurable `baseURL` | OpenAI, Azure OpenAI, OpenRouter, LiteLLM, Ollama, vLLM, and anything else that speaks the Chat Completions API |

API keys are encrypted with `MASTER_KEY` and are write-only. Use **Test** on a provider (`POST /api/settings/ai/providers/:id/test`) to run a minimal call and check the key, the base URL and the model.

### Anthropic

- **Kind:** `anthropic`
- **Base URL:** leave empty
- **API key:** from the Anthropic Console
- **Models:** for example `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`

With the Anthropic adapter:

- Structured output uses a JSON schema (`output_config.format`).
- The system prompt and repository profile use prompt caching. Cache reads are tracked as `cacheReadTokens` and cost less.
- A `refusal` stop reason is handled: the report falls back to deterministic analysis.

### OpenAI

- **Kind:** `openai_compatible`
- **Base URL:** `https://api.openai.com/v1`, or leave it empty for the default
- **API key:** an OpenAI key

### Azure OpenAI

- **Kind:** `openai_compatible`
- **Base URL:** `https://<resource>.openai.azure.com/openai/v1`. This is the v1-compatible endpoint. Older deployments may need `https://<resource>.openai.azure.com/openai/deployments/<deployment>`.
- **API key:** an Azure key
- **Model:** use your **deployment name** as the model

### OpenRouter

- **Kind:** `openai_compatible`
- **Base URL:** `https://openrouter.ai/api/v1`
- **Model:** use OpenRouter model ids, for example `anthropic/claude-sonnet-5-5`. Costs for known models are recognised through the `vendor/model` prefix.

### LiteLLM proxy

- **Kind:** `openai_compatible`
- **Base URL:** your proxy, for example `http://litellm:4000/v1`
- **API key:** a LiteLLM virtual key
- **Model:** whatever model names your proxy routes. This is a good fit for organizations that already centralise keys, logging and spend.

### Local models: Ollama and vLLM

Running a model locally keeps code entirely on your infrastructure.

- **Ollama:**
  - Kind: `openai_compatible`
  - Base URL: `http://ollama:11434/v1` from inside compose, or `http://host.docker.internal:11434/v1` to reach Ollama on the Docker host
  - API key: any non-empty string
  - Model: for example `qwen2.5-coder:32b`
- **vLLM:** start it with `--served-model-name`. Kind: `openai_compatible`. Base URL: `http://vllm:8000/v1`.

Local models must reliably produce JSON that matches the report schema. Invalid output is rejected, and that report falls back to deterministic analysis, with a note in `limitations`. Use capable instruction-tuned models with large context windows. Small models often fail validation on large PRs.

**Cost:** local or unknown models are recorded using the configurable fallback price, which is 0 when unset. They still count tokens.

## Model per task

| Task            | When it runs                                                                                        | Default             |
| --------------- | --------------------------------------------------------------------------------------------------- | ------------------- |
| `triage`        | On each new head SHA, to decide whether the change is meaningful enough to regenerate the narrative | `claude-haiku-5-5`  |
| `pr_report`     | Main report narrative for a PR                                                                      | `claude-sonnet-5-5` |
| `deep_analysis` | High-risk PRs and cross-PR semantic confirmation (duplicate work, semantic overlap)                 | `claude-opus-5-5`   |
| `digest`        | Daily digest prose                                                                                  | `claude-haiku-5-5`  |

Each task stores `{ providerId, model, maxOutputTokens }` (`ai_settings.task_models`), so tasks can use different providers. For example, you could use Anthropic for reports and a local model for triage. There is also a global `maxInputTokensPerCall` (default 120,000). Larger inputs are truncated with priority given to security, contract and migration files, and the truncation is recorded in `limitations`.

## Budget

| Setting             | Default | Effect                                                                                                         |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `monthlyBudgetUsd`  | 100     | Monthly cap on estimated spend, per calendar month                                                             |
| `alertThresholdPct` | 80      | A `budget_alert` notification is sent when this share of the budget is reached                                 |
| at 100%             |         | AI calls are skipped. Reports are deterministic and show an "AI budget reached" banner. Nothing fails silently |

Every call is recorded in `ai_usage` with the task, provider kind, model, input, output and cache-read tokens, cost and PR. See **Settings → AI → Usage** (`GET /api/usage`).

Costs are estimates from a built-in price table. Check your provider's invoice for exact figures.

## Data modes and what is sent

Data sent to the provider is governed by these controls:

1. **Org switch and consent.** No AI calls happen until an admin has enabled AI and given consent.
2. **Per-repository `ai_mode`:**
   - `full`: PR title, body and metadata, commit messages, repository profile, deterministic findings, and **redacted code diffs and snippets**.
   - `metadata_only`: PR title, body and metadata, file paths, symbol and contract names, and deterministic findings. **No code bodies.**
   - `off`: nothing from this repository is sent. Its reports are deterministic.
3. **`exclude_paths`.** Files matching these globs are removed before a prompt is built, in every mode.
4. **Secret redaction.** This is always on. Known token formats, PEM keys, credentials in URLs, authorization headers and high-entropy secret assignments are replaced with `[REDACTED:<rule>]` before prompting.

The AI is given **no tools**. All repository and PR content is wrapped as untrusted data, so it can't instruct the model. The output must validate against the report JSON schema. AI conclusions are always labelled **Potential concern** (`verified: false`). The AI can adjust a deterministic risk score by at most ±15 points, and must give a rationale. See [security.md](security.md#prompt-injection-defenses).

## Turning AI off

**Settings → AI → Disable** stops all AI calls immediately. Existing reports are kept. To delete provider keys, remove the provider.
