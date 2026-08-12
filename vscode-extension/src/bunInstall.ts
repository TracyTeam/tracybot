// Bun's own official one-line installers — kept manual/click-driven rather
// than silently auto-run: installing a new system-wide runtime and touching
// the user's shell profile is a bigger, more sensitive action than anything
// else this extension automates (all of which is scoped to files inside the
// user's own repo or its .git folder).
export function getBunInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash';
}
