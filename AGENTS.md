# AGENTS.md

This repository is the current `viforge` implementation for sitcom creation workflows. Future agents should treat the monorepo implementation and `docs/current/` as the source of truth, not the historical Express starter files that still exist in the repository.

## Read First

- Start with `docs/current/README.md`.
- Use the feature documents in `docs/current/` for architecture, workspace filesystem behavior, editor preview behavior, chat sessions, Codex runtime integration, skills/config, WeChat integration, and test commands.
- Shared request and response contracts live in `packages/shared/src/contracts.ts`; update them before changing either side of an API boundary.

## Project Shape

- `apps/web/` contains the React/Vite workbench UI.
- `apps/api/` contains the Hono API service, filesystem store, chat sessions, Codex runtime bridge, skills/config store, and WeChat routes.
- `apps/agent-worker/` and `apps/integration-gateway/` are supporting services.
- `packages/shared/` contains shared TypeScript contracts and workspace templates.
- `docs/current/` contains the latest implementation documentation for agent handoff.

## Development Rules

- Use `pnpm`.
- Keep web API calls centralized in `apps/web/src/api.ts`.
- Keep frontend tree behavior in `apps/web/src/workspace-tree.ts` and UI wiring in `apps/web/src/main.tsx`.
- Keep backend filesystem semantics in `apps/api/src/storage/workspaceStore.ts`.
- Keep chat session persistence in `apps/api/src/chat/chatSessionStore.ts`.
- Keep Codex runtime behavior in `apps/api/src/runs/codexRunService.ts` and related route files.
- Keep user-visible behavior aligned with sitcom creation, even when adapting patterns from the ifind-cowork reference.

## Local Data And Secrets

Do not commit runtime data or secrets. In particular, avoid staging:

- `apps/api/data/`
- `apps/web/dist/`
- `*.tsbuildinfo`
- `node_modules/`
- local IDE/tool folders such as `.idea/`, `.claude/`, `.qwen/`, and `.agents/`
- `.env` files or API keys

Agent configuration exposed inside the product is stored through the API data model and documented in `docs/current/07-skills-and-agent-config.md`. Runtime Codex home handling is documented in `docs/current/06-codex-agent-runtime.md`.

## Verification

Run targeted checks for the area you changed. Common commands:

```bash
pnpm --filter @viforge/api typecheck
pnpm --filter @viforge/web typecheck
pnpm --filter @viforge/web build
pnpm --filter @viforge/api test
pnpm --filter @viforge/web test
```

When changing contracts, run both API and web checks. When changing preview/editor behavior, include web tests around viewers and workspace tree behavior. When changing Codex runtime or sessions, include API route/store tests.

## Commit Scope

Commit implementation code, shared contracts, workspace package files, and current documentation together when they describe one coherent product state. Keep planning notes, generated runtime data, local agent homes, and unrelated deployment experiments out of normal feature commits unless the user explicitly asks for them.
