import * as fs from "fs";
import * as path from "path";
import { adrFileName, nextAdrNumber } from "./files";

// Kept free of the 'vscode' module so it can be unit-tested directly.

// Writes the draft into exactly the directory it is given, creating it if
// needed, and returns the new file's path. The 'wx' flag never overwrites (and
// doesn't follow a symlink planted at the target name); if another file took
// the number in the meantime, the next one is tried.
export function writeAdrFile(dir: string, title: string, taskletKey: string, markdown: string): string {
  fs.mkdirSync(dir, { recursive: true });

  for (let attempt = 0; attempt < 5; attempt++) {
    const file = path.join(dir, adrFileName(nextAdrNumber(dir), title, taskletKey));
    try {
      fs.writeFileSync(file, markdown, { flag: "wx" });
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") { throw err; }
    }
  }
  throw new Error("could not find a free ADR number");
}
