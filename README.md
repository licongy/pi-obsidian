# pi-obsidian

A monorepo of independently-published [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extensions that bridge the pi coding agent and [Obsidian](https://obsidian.md).

The flagship package is **`@pi-obsidian/bridge`** — infrastructure that lets the
pi agent read/write an Obsidian vault and call Obsidian plugin APIs through a
file-based RPC bridge. Control stays on the pi side; Obsidian acts as a
remote-controlled peripheral. See the [bridge design doc](docs/bridge.md) for the
full architecture and protocol.

Claudian-compatible but Claudian-independent: the bridge works in any pi run whose
working directory is an Obsidian vault root.

Each package lives in its own directory under `packages/*` and is published to npm
as TypeScript source (pi loads it via jiti, no build step), so you can install only
what you need:

```
pi install npm:<package-name>
```

## Packages

| Package                                 | Description                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`@pi-obsidian/bridge`](docs/bridge.md) | _Planned._ Bridge the pi agent to an Obsidian vault: read/write notes, search, and call Obsidian plugin APIs. |

## Development

Requires Node.js 20+ and [pnpm](https://pnpm.io).

```sh
pnpm install      # install dependencies
pnpm typecheck    # type-check all packages (tsc --noEmit)
pnpm lint         # check formatting with prettier
pnpm format       # fix formatting with prettier
```

## Debugging

All `@pi-obsidian` extensions support a shared debug switch. Set one environment
variable to trace every extension on stderr (never mixed with pi's stdout):

```sh
PI_OBSIDIAN_DEBUG=1 pi              # show debug output inline
PI_OBSIDIAN_DEBUG=1 pi 2>debug.log  # capture to a file
```

## Releasing

This repo uses [Changesets](https://github.com/changesets/changesets) for independent versioning and publishing of each extension.

```sh
pnpm changeset    # describe a change (creates a changeset file)
pnpm version      # apply changesets -> bump versions, update CHANGELOGs
pnpm release      # publish all changed packages to npm
```

See [`.changeset/README.md`](.changeset/README.md) for details.

## License

[MIT](LICENSE)
