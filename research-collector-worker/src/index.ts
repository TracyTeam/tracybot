import { timingSafeEqual } from "node:crypto";
import { submitRequestSchema } from "./schema";
import { tryConsumeRateLimit } from "./rateLimit";
import { writeFileToCollector } from "./github";

const COLLECTOR_REPO = "EsmeYi/tracybot_collector";

function submissionFileName(taskletId: string, submittedAt: string): string {
  const safeTimestamp = submittedAt.replace(/[:.]/g, "-");
  return `${safeTimestamp}_${taskletId}.json`;
}

// The submit key is embedded in the publicly-published extension source, so
// it's public knowledge by design, not a leak-able secret — see
// collectorRepo.ts on the extension side. Still compared in constant time so
// the auth check itself doesn't become a side channel for anything else.
function isAuthorized(request: Request, expectedKey: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");

  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expectedKey);
  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(providedBytes, expectedBytes);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/submit") {
      return new Response("Not Found", { status: 404 });
    }

    if (!isAuthorized(request, env.SUBMIT_KEY)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const parsed = submitRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: "Payload failed schema validation", issues: parsed.error.issues }, 400);
    }

    const { payloads } = parsed.data;
    const participantId = payloads[0].participant_id;

    const withinLimit = await tryConsumeRateLimit(env.RATE_LIMIT, participantId, payloads.length);
    if (!withinLimit) {
      return jsonResponse({ error: "Daily submission limit exceeded" }, 429);
    }

    try {
      const results = await Promise.all(
        payloads.map(async payload => {
          const filePath = `${payload.participant_id}/${submissionFileName(payload.tasklet_id, payload.submitted_at)}`;
          const result = await writeFileToCollector(
            env.GITHUB_TOKEN,
            COLLECTOR_REPO,
            filePath,
            JSON.stringify(payload, null, 2)
          );
          return { tasklet_id: payload.tasklet_id, ok: result.ok };
        })
      );

      return jsonResponse(
        {
          sent: results.filter(r => r.ok).map(r => r.tasklet_id),
          failed: results.filter(r => !r.ok).map(r => r.tasklet_id),
        },
        200
      );
    } catch (err) {
      console.error("tracybot-research-collector: submission failed", err);
      return jsonResponse({ error: "Internal error while writing submissions" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
