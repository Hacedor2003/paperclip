---
title: Docker
summary: Docker Compose quickstart
---

Run Paperclip in Docker without installing Node or pnpm locally.

## Compose Quickstart (Recommended)

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open [http://localhost:3100](http://localhost:3100).

Defaults:

- Host port: `3100`
- Data directory: `./data/docker-paperclip`

Override with environment variables:

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**Note:** `PAPERCLIP_DATA_DIR` is resolved relative to the compose file (`docker/`), so `../data/pc` maps to `data/pc` in the project root.

## Manual Docker Build

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-paperclip`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Local Adapter CLIs in Docker

The Docker image pre-installs these agent CLIs so their `*_local` adapters can run inside the container:

- `claude` (Anthropic Claude Code CLI) — `claude_local`
- `codex` (OpenAI Codex CLI) — `codex_local`
- `opencode` (OpenCode multi-provider CLI) — `opencode_local`
- `gemini` (Google Gemini CLI) — `gemini_local` (experimental)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e GEMINI_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

Each adapter reads its provider's standard credentials — for example `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (Codex), and `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini). OpenCode is multi-provider and uses whichever provider key you supply.

The image ships five agent CLIs: Claude Code, Codex, OpenCode, Gemini and Kimi. If you only set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, only Claude and Codex agents have credentials — the other three are installed but unusable. `OPENROUTER_API_KEY` is the highest-leverage single key: it backs OpenCode across hundreds of models, and the native runner's default model is already an `openrouter/...` id.

Keys are not the only route. You can create an agent in the UI and paste a provider key there (**New agent → adapter → provider + API key**), which stores it as a company secret instead of a container-wide variable. OpenRouter is also available as a managed **AI connection** (Connectors → OpenRouter), which binds to OpenCode agents whose model id starts with `openrouter/`.

### Trying Paperclip on free models

OpenRouter serves some models at no token cost, which is enough to exercise a
whole company end to end before committing spend.

1. Create an OpenRouter API key and start the stack with `OPENROUTER_API_KEY` set.
2. **New agent → OpenCode**, and pick `openrouter` as the provider.
3. In the model dropdown, type `free`. The list narrows to the no-cost models
   and each one carries a **Free** badge.

The badge is derived from OpenRouter's published pricing at the moment the
catalog is fetched — both the prompt and completion price must be zero. It is a
selection hint, not a guarantee: a provider can start charging for a model, and
the catalog is cached for a minute, so treat it as "free right now" rather than
"free forever". Models whose pricing the catalog does not publish carry no badge
at all rather than being assumed free.

Free models are rate-limited far more aggressively than paid ones — OpenRouter
caps them per minute and per day — and an agent loop reaches those caps quickly.
Paperclip classifies a throttled OpenCode run as retryable rather than failing
the task outright: a burst limit is reported as `transient_upstream`, and an
exhausted daily allowance as `provider_quota`, honoring the provider's
`retry-after` hint when it sends one. Expect runs to pause rather than die. If a
company stalls on `provider_quota`, the allowance is spent for the day — switch
the agent to another free model or add credit.

> **Gemini key restrictions:** Google requires Gemini API keys to be *restricted* to the Gemini API (scoped in the Google Cloud console); unrestricted keys are blocked and `gemini_local` runs will fail with an auth error. Create a restricted key, or authenticate with `gemini auth login` (OAuth) and persist `~/.gemini` via the data volume so the credential survives container restarts.

The image sets `GEMINI_SANDBOX=false` so the Gemini CLI does not try to launch its own (Docker-in-Docker) sandbox inside the container. The `gemini_local` adapter already passes `--sandbox=none` per run, so this env var only matters if you invoke `gemini` manually inside the container; override it if you have nested-container support and want CLI-level sandboxing.

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
