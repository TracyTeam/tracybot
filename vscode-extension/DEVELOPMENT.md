# Developing the Tracybot VS Code Extension

This covers building, packaging, and debugging the extension from source. For what the extension does and how to install it, see [README.md](./README.md).

## Install Dependencies

```bash
npm install
```

## Build the Extension

```bash
npm run compile
```

## Package the Extension (build VSCE package)

```bash
npm run package
```

## Deploy the Extension (build and install VSCE package)

```bash
npm run deploy
```

## Launch in Debug Mode

Open `src/extension.ts` in VS Code and press `F5` to launch the extension debugger.

## Install a Packaged VSIX Manually

A VSIX package can be installed from the CLI:
```bash
code --install-extension vscode-extension.vsix
```

Build outputs are stored in `./out/`.

Latest released `vscode-extension.vsix` can be downloaded from the [latest release](https://github.com/TracyTeam/tracybot/releases/latest).

## Tests

```bash
npm run test:unit   # node:test suite under src/research/**/*.test.ts
npm run lint
```

## Data Model

A Tasklet's Zod schema is defined in `src/history/types.ts`.
