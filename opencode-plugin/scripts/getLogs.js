import fs from "fs";
import path from "path";
import os from "os";

// The plugin writes JSON lines here (see src/Logger.ts); OpenCode 2.x has no
// plugin logging API, so these entries are no longer in OpenCode's own log.
const LOG_PATH = path.join(os.homedir(), ".local/share/opencode/log/tracybot-plugin.jsonl");

function main() {
    if (!fs.existsSync(LOG_PATH)) {
        console.error(JSON.stringify({ error: `Log file not found: ${LOG_PATH}` }));
        process.exit(1);
    }

    const entries = fs.readFileSync(LOG_PATH, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return { error: "Failed to parse JSON line", rawString: line };
            }
        });

    console.log(JSON.stringify(entries, null, 2));
}

main();
