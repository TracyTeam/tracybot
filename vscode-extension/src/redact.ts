// Shared by Research Mode payloads and ADR drafts: both put the user's prompt
// and the AI's reply text somewhere it can leave the machine or be committed,
// so they strip the same things.

export function redactFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "[code omitted]");
}

// Agents often reference files with markdown links or plain paths, e.g.
// "I edited [utils.ts](/Users/esme/projects/secret-client/src/utils.ts)" —
// an absolute path rooted in a home directory leaks the participant's
// username and local project/directory names, neither of which
// redactFencedCode catches since this text sits outside any code fence.
// Scoped to home-directory-style paths (not every "/" in the text) so it
// doesn't also mangle unrelated content like URLs or in-repo relative paths.
const HOME_DIR_PATH_RE = /(?<![\w.:/\\])(?:\/Users\/|\/home\/|~\/|[A-Za-z]:\\Users\\)[^\s)\]`"']+/g;

// Trailing sentence punctuation (". "/", "/etc.) is a valid path character as
// far as the regex is concerned, so a match like "config.json." would
// otherwise swallow the full stop ending the sentence. Strip it back off
// and keep it outside the placeholder.
export function redactFilePaths(text: string): string {
  return text.replace(HOME_DIR_PATH_RE, match => {
    const path = match.replace(/[.,;:!?]+$/, "");
    return "<path omitted>" + match.slice(path.length);
  });
}

export function redactSensitiveText(text: string): string {
  return redactFilePaths(redactFencedCode(text));
}
