import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
    await client.app.log({
        body: {
            service: "tracybot-plugin",
            level: "info",
            message: "Plugin initialized",
        },
    })

    return {
        // Hook implementations go here
        event: async ({ event }) => {
            await client.app.log({
                body: {
                    service: "tracybot-plugin",
                    level: "info",
                    message: event.type,
                    extra: { type: "event", object: event }
                },
            })
        },

        "permission.ask": async (input, output) => {
            await client.app.log({
                body: {
                    service: "tracybot-plugin",
                    level: "info",
                    message: "permission.ask received",
                    extra: {
                        type: "event",
                        object: {
                            input: input,
                            output: output,
                        }
                    }
                }
            });
            // You could modify output.status here ("allow", "deny", or "ask")
        },

        "tool.execute.before": async (input, output) => {
            await client.app.log({
                body: {
                    service: "tracybot-plugin",
                    level: "info",
                    message: "tool.execute.before received",
                    extra: {
                        type: "event",
                        object: {
                            input: input,
                            output: output,
                        }
                    }
                }
            });
            // You could modify output.args here
        },

        "tool.execute.after": async (input, output) => {
            await client.app.log({
                body: {
                    service: "tracybot-plugin",
                    level: "info",
                    message: "tool.execute.after received",
                    extra: {
                        type: "event",
                        object: {
                            input: input,
                            output: output,
                        }
                    }
                }
            });
            // You could modify output.result here
        },

        "shell.env": async (input, output) => {
            await client.app.log({
                body: {
                    service: "tracybot-plugin",
                    level: "info",
                    message: "shell.env received",
                    extra: {
                        type: "event",
                        object: {
                            input: input,
                            output: output,
                        }
                    }
                }
            });
            // You could add keys to output.env here
        },

        "experimental.session.compacting": async (input, output) => {
            await client.app.log({
                body: {
                    service: "tracybot-plugin",
                    level: "info",
                    message: "experimental.session.compacting received",
                    extra: {
                        type: "event",
                        object: {
                            input: input,
                            output: output,
                        }
                    }
                }
            });
        }
    }
}
