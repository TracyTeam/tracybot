# Tracybot VS Code Extension

A VS Code extension that helps trace AI generated code back to prompts by displaying tasklet information.

## What It Does

The extension queries the Git repository to reconstruct the history of AI interactions by:
1. Reading hidden commits from the `refs/tracy/*` namespace
2. Extracting metadata from commit objects
3. Building a timeline that maps code changes to AI interactions

## How to Run

### Build the Extension

```bash
npm run compile
```

### Launch in Debug Mode

Open `src/extension.ts` in VS Code and press **F5** to launch the extension debugger.

## Requirements

- Node.js v22 or later
- npm
- A repository initialized with `init.py`

## AI Blame Tab

Displays the history of AI-generated code changes in a dedicated tab. The button is located in the bottom right of VS Code.

- **Highlighted lines**: Each file highlights AI-generated lines
- **Tasklet details**: Click on any highlighted line to see the originating tasklet
  - A tasklet consists of 0 or more plan prompts followed by a build prompt and contains both user prompts and AI responses
  - A tasklet Zod schema is available under `src/histoy/types.ts`
- **File history**: View all tasklets that modified the current version of the file

## Keybindings

- `Cmd+Shift+0` (Mac) / `Ctrl+Shift+0` (Windows/Linux) - Open AI Blame window