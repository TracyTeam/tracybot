import { TaskletResearchPayload } from "./types";

// Public by design — this key is embedded in the publicly-published extension
// source (this file, on GitHub), so it's known to anyone who reads the repo,
// not just something that could theoretically be reverse-engineered. Security
// comes entirely from the relay's server-side posture (write-only, rate
// limited, schema-validated), not from this value being secret. See
// research-collector-worker/src/index.ts.
const SUBMIT_ENDPOINT = "https://tracybot-research-collector.onelirong.workers.dev/submit";
const SUBMIT_KEY = "7e7586f1-8f06-4996-8576-56639e49d071";

interface SubmitResponse {
  sent: string[];
  failed: string[];
}

// Posts every pending payload in one request to the research relay, which
// validates, rate-limits, and writes each one into the private collector repo
// server-side. Returns the tasklet_ids the relay confirmed it wrote — callers
// should only clear those from the local pending queue (queue.ts). Anything
// not returned (including everything, if this throws) stays queued and is
// retried on the next call.
export async function submitPayloads(payloads: TaskletResearchPayload[]): Promise<string[]> {
  if (payloads.length === 0) {
    return [];
  }

  const response = await fetch(SUBMIT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUBMIT_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payloads }),
  });

  if (!response.ok) {
    throw new Error(`Research Mode submission failed: HTTP ${response.status}`);
  }

  const result = await response.json() as SubmitResponse;
  return result.sent;
}
