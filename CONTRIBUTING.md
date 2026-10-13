# Contributing to Skyline

Thanks for helping. Skyline is an Electron app with a main process, a preload bridge and a React and three.js renderer. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit.

## Dev setup

Requirements: Node.js 22 and npm. Windows is the target platform. The test and typecheck commands run on any OS.

```bash
git clone <this repo>
cd <this repo>
npm ci          # also runs electron-builder install-app-deps
npm run dev     # app with hot reload
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the app with the electron-vite dev server. |
| `npm run typecheck` | Type-check main, preload and shared (`tsconfig.node.json`), then the renderer (`tsconfig.web.json`). |
| `npm test` | Run the vitest suite once. |
| `npm run build` | Bundle everything into `out/`. |
| `npm run dist:win` | Build the Windows installer and portable exe into `release/`. |
| `npm run make-icon` | Regenerate `resources/icon.ico`. |

Run `npm run typecheck` and `npm test` before you open a PR. CI runs both, plus the build and packaging.

## Tests

Tests sit next to the code they cover, in `__tests__/` folders, and use vitest.

- Pure logic in `src/shared` (layout, pricing, language mapping, color) and parsers in `src/main` are the priority. Keep them free of I/O so they are easy to test.
- Parser fixtures live in `src/main/agents/__tests__/fixtures/`. Use real-looking but anonymized transcript lines.
- Git tests use a throwaway repo from `src/main/repo/__tests__/git-fixture.ts`.

## Project layout

```
src/shared/    contract types, IPC channel names, layout, pricing, languages (pure)
src/main/      RepoSession, AgentHub, parsers, repo scan and watch, git, dispatch, local LLM
src/preload/   window.skyline bridge
src/renderer/  React HUD (hud/), three.js city (city/), zustand store (state/)
docs/          architecture, launch kit, landing page and screenshots
```

## Common changes

- **New agent source.** Add a parser in `src/main/agents/`, wire it into `AgentHub.discover()`, and add fixtures and tests.
- **New or changed model price.** Edit `MODEL_PRICES` in `src/shared/pricing.ts`. Order matters: put specific ids before general ones. Add a test.
- **New language.** Add it to `src/shared/lang.ts`, with its extensions, label and color.
- **New keyboard shortcut.** Add it to `onKeyDown` in `src/renderer/src/App.tsx`, skip it while typing or while an overlay is open, and update the table in the README.
- **UI change.** Include a before and after screenshot in the PR description.

## Pull requests

- Keep PRs small and focused. One behavior change per PR.
- Use an imperative subject line, with an optional area prefix, for example `HUD: clear selection on Esc` or `Pricing: add Haiku 5.5`.
- Describe what changed and why, and how you tested it.
- Update the docs (README, ARCHITECTURE) when behavior changes.
- Do not commit build output (`out/`, `release/`) or `node_modules/`. `.gitignore` already covers them.

## Reporting bugs

Open an issue with your Windows version, Skyline version, which agent (Claude Code, Codex) was involved, and the steps to reproduce. If a transcript is involved, redact any prompts or code from it before you attach it.

## License

By contributing, you agree that your contributions are released under the [MIT License](LICENSE).
