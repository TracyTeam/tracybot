import type { createOpencodeClient } from "@opencode-ai/sdk/client";

type Extras = { [key: string]: unknown }
type Client = ReturnType<typeof createOpencodeClient>

export class Logger {
    private PLUGIN_NAME = "tracybot-plugin"
    private client: Client

    constructor(client: Client) {
        this.client = client
    }

    private async _log(level: "debug" | "info" | "error" | "warn", msg: string, extra?: Extras) {
        await this.client.app.log({
            body: {
                service: this.PLUGIN_NAME,
                level: level,
                message: msg,
                extra: extra,
            },
        })
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
