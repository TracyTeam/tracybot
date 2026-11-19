import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

type Extras = { [key: string]: unknown }
type Level = "debug" | "info" | "error" | "warn"

// OpenCode 2.x plugins have no logging API (1.x had client.app.log), so the
// plugin writes JSON lines next to OpenCode's own logs. `bun run logs` reads them.
export const LOG_PATH = path.join(homedir(), ".local", "share", "opencode", "log", "tracybot-plugin.jsonl")

export class Logger {
    private ready: Promise<unknown> = mkdir(path.dirname(LOG_PATH), { recursive: true }).catch(() => {})

    private async _log(level: Level, msg: string, extra?: Extras) {
        const line = JSON.stringify({ timestamp: new Date().toISOString(), service: "tracybot-plugin", level, message: msg, extra })
        try {
            await this.ready
            await appendFile(LOG_PATH, line + "\n")
        } catch {
            // Logging must never break the agent.
        }
    }

    public async debug(msg: string, extra?: Extras) {
        await this._log("debug", msg, extra)
    }
    public async info(msg: string, extra?: Extras) {
        await this._log("info", msg, extra)
    }
    public async error(msg: string, extra?: Extras) {
        await this._log("error", msg, extra)
    }
    public async warn(msg: string, extra?: Extras) {
        await this._log("warn", msg, extra)
    }
}
