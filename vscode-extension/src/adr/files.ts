import * as fs from "fs";
import * as path from "path";

// Kept free of the 'vscode' module so it can be unit-tested directly.

export const DEFAULT_ADR_DIR = "docs/adr";
const MAX_SLUG_CHARS = 50;

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= MAX_SLUG_CHARS) { return slug; }
  // Cut on a word boundary where there is one, rather than mid-word.
  const cut = slug.slice(0, MAX_SLUG_CHARS);
  const boundary = cut.lastIndexOf("-");
  return (boundary > MAX_SLUG_CHARS / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/, "");
}

// The directory comes from a user setting, so it must stay inside the repo.
// A lexical check isn't enough: if `docs` or `docs/adr` is a symlink to
// somewhere else, creating and refreshing ADRs would read and write outside the
// repository. So the deepest part of the path that already exists is resolved
// to its real location and has to be inside the repository's real location.
export function resolveAdrDir(repoPath: string, setting: string | undefined): string | undefined {
  const relative = (setting ?? "").trim() || DEFAULT_ADR_DIR;
  const resolved = path.resolve(repoPath, relative);
  const fromRepo = path.relative(path.resolve(repoPath), resolved);
  if (fromRepo === "" || fromRepo.startsWith("..") || path.isAbsolute(fromRepo)) { return undefined; }

  try {
    // lstat (not exists): a dangling symlink must be found here, not skipped.
    let existing = resolved;
    for (;;) {
      try { fs.lstatSync(existing); break; } catch {
        const parent = path.dirname(existing);
        if (parent === existing) { return undefined; }
        existing = parent;
      }
    }

    const realFromRepo = path.relative(fs.realpathSync(repoPath), fs.realpathSync(existing));
    if (realFromRepo.startsWith("..") || path.isAbsolute(realFromRepo)) { return undefined; }
  } catch {
    return undefined; // e.g. a dangling symlink
  }
  return resolved;
}

export function nextAdrNumber(dir: string): number {
  let max = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 1;
  }
  for (const name of names) {
    const match = name.match(/^(\d+)-/);
    if (match) { max = Math.max(max, parseInt(match[1], 10)); }
  }
  return max + 1;
}

// A title with no latin letters (e.g. Chinese) slugifies to nothing; fall
// back to part of the tasklet id so the file still gets a stable, unique name.
export function adrFileName(number: number, title: string, taskletKey: string): string {
  const slug = slugify(title) || `tasklet-${taskletKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase()}`;
  return `${String(number).padStart(4, "0")}-${slug || "decision"}.md`;
}

// Regular files only: a symlinked .md could point outside the repository, and
// refreshing would rewrite whatever it points to.
export function listAdrFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.md$/i.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .map(name => path.join(dir, name));
  } catch {
    return [];
  }
}
