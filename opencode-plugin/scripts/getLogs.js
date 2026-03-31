import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".local/share/opencode/log");
const PLUGIN_NAME = "tracybot-plugin";

function main() {
    if (!fs.existsSync(LOG_DIR)) {
        console.error(JSON.stringify({ error: `Log directory not found: ${LOG_DIR}` }));
        process.exit(1);
    }

    const files = fs.readdirSync(LOG_DIR)
        .filter(file => file.endsWith(".log"))
        .map(file => ({
            name: file,
            time: fs.statSync(path.join(LOG_DIR, file)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

    if (files.length === 0) {
        console.error(JSON.stringify({ error: "No logs found." }));
        process.exit(0);
    }

    const latestLogPath = path.join(LOG_DIR, files[0].name);
    const logContent = fs.readFileSync(latestLogPath, "utf-8");
    const lines = logContent.split("\n").filter(Boolean);

    const outputLogs = [];

    for (const line of lines) {
        if (!line.includes(`service=${PLUGIN_NAME}`)) continue;

        const timeMatch = line.match(/INFO\s+([\d-T:]+)/);
        const timestamp = timeMatch ? timeMatch[1] : null;

        const logEntry = {
            timestamp: timestamp,
            service: PLUGIN_NAME,
        };

        const eventIndex = line.indexOf("event={");

        if (eventIndex !== -1) {
            const jsonStart = eventIndex + 6;
            const jsonEnd = line.lastIndexOf("}");

            if (jsonEnd > jsonStart) {
                const jsonStr = line.substring(jsonStart, jsonEnd + 1);

                try {
                    logEntry.event = JSON.parse(jsonStr);
                } catch (err) {
                    logEntry.error = "Failed to parse JSON payload";
                    logEntry.rawString = jsonStr;
                }
            }
        } else {
            const rawMessage = line.split(`service=${PLUGIN_NAME}`)[1]?.trim() || line;
            logEntry.message = rawMessage;
        }

        outputLogs.push(logEntry);
    }

    console.log(JSON.stringify(outputLogs, null, 2));
}

main();
