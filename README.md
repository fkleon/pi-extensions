# Pi Extensions

Personal source repository for locally maintained Pi extensions, packaged for Pi's package loader as `@fkleon/pi-extensions`.

## Install

From this repository, install the package into your user-level Pi settings:

```sh
pi install .
```

The package points directly at the extension source in this checkout; it does not use a symlink. To uninstall it from Pi, run `pi remove .` from this directory. After editing extension source, run `/reload` in an open Pi session or restart Pi.

## Development

Install the development dependency, then use Biome to lint, format, or check the repository:

```sh
npm install
npm run lint
npm run format
npm run check
```

Biome configuration is in `biome.json`.

## `mcp-tool-filter`

`extensions/mcp-tool-filter.ts` blocks configured MCP tool calls before execution. By default, it blocks only `mcp__radius__tools_webFetch_run`.

In Pi, use `/tool-filter` to inspect rules, then:

- `/tool-filter block <tool-name-or-pattern>` to add a block rule
- `/tool-filter allow <tool-name-or-pattern>` to remove that exact rule
- `/tool-filter reset` to restore the default

Rule changes are stored in `~/.pi/agent/mcp-tool-filter.json` (or the directory selected by `PI_CODING_AGENT_DIR`).

## Adding extensions

Place extension source files in `extensions/` and add them to the `pi.extensions` array in `package.json`. For Pi's package format and extension API, see the [official package documentation](https://pi.dev/docs/latest/packages) and [extension documentation](https://pi.dev/docs/latest/extensions). For Biome installation and CLI details, see the [official Biome documentation](https://biomejs.dev/guides/getting-started/).
