# ViForge

ViForge is a local-first AI collaboration workbench for creative and knowledge work. It helps people turn ideas, judgment, and personal methodology into reusable agents, skills, knowledge bases, and evaluable workflows.

ViForge is not a single-purpose scriptwriting tool, and it is not another generic coding desktop shell. The product direction is human-in-the-loop creative collaboration: people provide taste, intent, direction, constraints, and review; agents help read, organize, generate, revise, inspect, and preserve reusable working methods.

## Positioning

ViForge focuses on:

- Creative and knowledge workflows rather than only coding or office automation.
- Local-first workspaces where project files, agent configuration, memory, logs, and evaluation artifacts stay on the user's machine by default.
- Customizable product profiles for domains such as novel adaptation, sitcom creation, and study workflows.
- Reusable agents, skills, prompts, knowledge bases, and memory policies that can evolve with a user's personal methodology.
- Agent Harness evaluation so agent changes can be reproduced, compared, reviewed, released, and rolled back.

## What Is Included

- `apps/web`: React + Vite workbench UI with workspace tree, editor/preview tabs, assistant chat, model settings, WeChat entry, Git sync, schedules, and Agent Harness.
- `apps/api`: Hono API service for workspace files, chat sessions, LangGraph runs, skills/config, runtime settings, desktop static hosting, and WeChat routes.
- `apps/desktop`: Electron desktop shell that starts the local API, serves the built web UI, starts bundled Playwriter relay, and uses embedded PostgreSQL in desktop mode.
- `packages/shared`: shared contracts, product profiles, default templates, prompts, and workspace structures.
- `docs/current`: implementation documentation for architecture, workspace behavior, editor preview, chat sessions, LangGraph runtime, skills/config, desktop packaging, and tests.

## Quick Start For Development

Install dependencies:

```bash
pnpm install
```

Run the API and web app:

```bash
pnpm dev
```

Default ports:

- Web: `http://localhost:5173`
- API: `http://localhost:3001`

Run desktop development mode after building web/API assets as needed:

```bash
pnpm dev:desktop
```

Build a desktop directory package:

```bash
pnpm desktop:pack
```

Build an installer:

```bash
pnpm desktop:dist
```

Desktop packaging requires PostgreSQL resources under `apps/desktop/resources/postgres/<platform>-<arch>` or an external bundle supplied through `VIFORGE_POSTGRES_BUNDLE_SOURCE`. See [docs/current/19-desktop-release-guide.md](./docs/current/19-desktop-release-guide.md).

## Model Configuration

ViForge does not include a hosted model service. Configure an OpenAI-compatible provider in the app's runtime settings or through environment variables.

Common variables:

| Variable | Purpose |
| --- | --- |
| `VIFORGE_AIGC_HUB_BASE_URL` | OpenAI-compatible base URL |
| `VIFORGE_AIGC_HUB_API_KEY` | API key for the configured provider |
| `VIFORGE_AIGC_HUB_CHAT_MODEL` | Text/chat model id |
| `VIFORGE_AIGC_HUB_IMAGE_MODEL` | Image generation/edit model id |
| `VIFORGE_AIGC_HUB_EMBEDDING_MODEL` | Embedding model id |
| `VIFORGE_LANGGRAPH_STORE_EMBEDDING_DIMS` | Embedding dimension for LangGraph Store |
| `VIFORGE_PRODUCT` | Default product profile: `novel-adaptation`, `sitcom`, or `study` |

Runtime settings store API keys locally. The API only returns whether a key is configured; it does not echo the stored secret back to the web UI.

## Local Data

Desktop mode asks the user to choose a data directory on first launch. That directory stores:

- Workspaces and project files: `<dataRoot>/workspaces`
- Runtime settings: `<dataRoot>/runtime-config.json`
- Logs: `<dataRoot>/logs`
- Embedded PostgreSQL data: `<dataRoot>/postgres-data`
- Chat sessions, agent memory, Harness artifacts, and related local runtime data under the configured data root or workspaces root

Service/development mode defaults to `~/.viforge/data/<productId>/workspaces` unless `WORKSPACES_ROOT` is set.

Do not commit runtime data or secrets. In particular, avoid staging `apps/api/data/`, `var/`, `release/`, `apps/web/dist/`, `apps/desktop/dist/`, `node_modules/`, `.env`, and local tool folders.

## Browser Automation Boundary

ViForge uses Playwriter browser tools to connect to user-authorized real browser tabs. The agent cannot access pages that have not been authorized through the browser extension or relay.

For high-risk browser actions, agents must ask for user confirmation before proceeding. High-risk actions include login, authorization, publishing, sending, deleting remote data, payments, purchases, account binding, and changing online configuration.

If Playwriter is missing, the relay is unavailable, or no browser tab is authorized, the agent must say that explicitly and provide setup steps rather than pretending it has accessed the web page.

## Open Source And Notices

This repository is licensed under the MIT License. See [LICENSE](./LICENSE).

Third-party and bundled binary notices are tracked in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Desktop releases that bundle PostgreSQL, pgvector, Electron, Chromium, or other redistributable binaries must include their required license and notice texts.

The ViForge name is a product name and may be subject to separate trademark or branding review before public release.

## Common Commands

```bash
pnpm --filter @viforge/api typecheck
pnpm --filter @viforge/web typecheck
pnpm --filter @viforge/web build
pnpm --filter @viforge/api test
pnpm --filter @viforge/web test
pnpm desktop:pack
```

When changing shared contracts, run both API and web checks. When changing desktop runtime behavior, include desktop packaging checks where the required PostgreSQL bundle is available.

## Documentation

Start with [docs/current/README.md](./docs/current/README.md) for current implementation details.

Planning and release documents:

- [Product roadmap](./docs/product-roadmap.md)
- [ViForge open source release checklist](./docs/viforge-open-source-release-checklist.md)
- [Desktop release guide](./docs/current/19-desktop-release-guide.md)

## Repository Guide

Future agents and contributors should read [AGENTS.md](./AGENTS.md) before making changes. Shared request and response contracts live in [packages/shared/src/contracts.ts](./packages/shared/src/contracts.ts); update them before changing either side of an API boundary.
