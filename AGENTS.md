# AGENTS.md

Guidance for agents (and humans) working in this repo.

## Project

Monorepo of independently-published Pi extensions that bridge the Pi coding agent
and Obsidian. One publishable package per directory under `packages/*`. Each
package publishes its `index.ts` **source** to npm (Pi loads it via jiti, no
compile step) so users can `pi install npm:<package-name>`.

The flagship package is `@pi-obsidian/bridge`: infrastructure that lets the Pi
agent read/write an Obsidian vault and call Obsidian plugin APIs via a file-based
RPC bridge. See [`docs/bridge.md`](docs/bridge.md) for the full design and the
bridge protocol — the protocol is the命门 and must be reviewed before code.

## Commands

Run from the repo root:

- `pnpm install` — install dependencies
- `pnpm typecheck` — type-check all packages (`tsc --noEmit`)
- `pnpm lint` — `prettier --check .`
- `pnpm format` — `prettier --write .`
- `pnpm changeset` — add a changeset describing a change
- `pnpm version` — apply changesets, bump versions, update CHANGELOGs
- `pnpm release` — publish all changed packages to npm

Per-package equivalents exist (e.g. `pnpm --filter @pi-obsidian/bridge typecheck`).

## Conventions

- TypeScript: strict, ESM (`"type": "module"`), `module: NodeNext`,
  `verbatimModuleSyntax`. Type-only imports must use `import type`.
- Shared compiler options live in `tsconfig.base.json` (`noEmit`); each package
  extends it. `tsc` is used only for type-checking, not for emitting `dist/`.
- Extension entry is `index.ts` exporting a default factory
  `(pi: ExtensionAPI) => void | Promise<void>`.
- `pi.extensions` manifest points at the `.ts` source; Pi loads it via jiti.
- `@earendil-works/pi-coding-agent` is a peer dependency (provided by Pi at
  runtime) and a dev dependency (for type-checking). It is imported as types
  only, so it never appears in published files.
- Debug logging: every package vendors a `debug.ts` that prints to stderr when
  `PI_OBSIDIAN_DEBUG` is set. See `packages/bridge/debug.ts` for the pattern.
- Before committing, run `pnpm typecheck` and `pnpm lint`.

## Two-sided packages (bridge-specific)

The `@pi-obsidian/bridge` package ships **two** runtime artifacts:

1. **Pi side** — `index.ts` (TypeScript source, loaded by jiti). Registers tools,
   owns the bridge client, enforces security, probes liveness.
2. **Obsidian side** — `obsidian-side/main.js` (plain hand-written JS, **no build
   step**) plus `obsidian-side/manifest.json`. This is a tiny Obsidian plugin that
   the Pi side injects into `.obsidian/plugins/pi-obsidian-bridge/` on first load;
   the user enables it once. It is also publishable as an official Obsidian
   community plugin later.

The Obsidian side must stay dependency-free plain JS so it can run inside
Obsidian's Electron environment without bundling. The `obsidian` npm package (types
only) is a devDependency for type-checking the plugin against Obsidian's API, but
the published `main.js` must not `import "obsidian"` (Obsidian provides it as a
global at runtime).

## Releases

Uses Changesets. Add a changeset (`pnpm changeset`) for any user-facing change,
then `pnpm version` and `pnpm release`. Each package versions independently.
