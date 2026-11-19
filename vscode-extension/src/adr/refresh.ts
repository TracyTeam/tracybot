import { History } from "../history/types";
import { computeTaskletStatus, describeStatusBasis, AdrStatus } from "./status";

// Kept free of the 'vscode' module so it can be unit-tested directly.

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/;
const COMPUTED_STATUSES = new Set<string>(["proposed", "accepted", "superseded"]);

export type RefreshOutcome =
  | { kind: "not-tracybot" }
  | { kind: "tasklet-missing"; key: string }
  | { kind: "manual-status"; status: string }
  | { kind: "ok"; markdown: string; changed: boolean; status: AdrStatus };

// Reads the quoted value of a one-line front matter key.
function frontMatterValue(header: string, key: string): string | undefined {
  const match = header.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m"));
  if (!match) { return undefined; }
  const raw = match[1].replace(/\r$/, "");
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw) as string; } catch { return raw; }
  }
  return raw;
}

export function readAdrTaskletKey(markdown: string): string | undefined {
  const header = markdown.match(FRONT_MATTER)?.[0];
  return header ? frontMatterValue(header, "tracybot-tasklet") : undefined;
}

// The "(checked 2026-10-13)" suffix changes every day; ignore it when deciding
// whether anything real changed, so refreshing doesn't rewrite files (and make
// git noise) when the code hasn't moved.
const withoutCheckedDate = (basis: string) => basis.replace(/ \(checked \d{4}-\d{2}-\d{2}\)$/, "");

// Rewrites only the `status` and `tracybot-status-basis` lines of the front
// matter. Everything after it, including anything a person has written, is
// returned byte for byte. A status a person set by hand (rejected, deprecated,
// ...) is respected, not overwritten.
export function refreshAdrStatus(markdown: string, history: History, now: Date): RefreshOutcome {
  const header = markdown.match(FRONT_MATTER)?.[0];
  const key = header ? frontMatterValue(header, "tracybot-tasklet") : undefined;
  if (!header || key === undefined) { return { kind: "not-tracybot" }; }

  const current = frontMatterValue(header, "status");
  if (current !== undefined && !COMPUTED_STATUSES.has(current)) {
    return { kind: "manual-status", status: current };
  }

  const computed = computeTaskletStatus(history, key);
  if (!computed) { return { kind: "tasklet-missing", key }; }

  const basis = describeStatusBasis(computed, now.toISOString().slice(0, 10));
  const oldBasis = frontMatterValue(header, "tracybot-status-basis") ?? "";
  if (current === computed.status && withoutCheckedDate(oldBasis) === withoutCheckedDate(basis)) {
    return { kind: "ok", markdown, changed: false, status: computed.status };
  }

  const newHeader = header
    .replace(/^status:.*$/m, `status: ${computed.status}`)
    .replace(/^tracybot-status-basis:.*$/m, `tracybot-status-basis: ${JSON.stringify(basis)}`);
  return { kind: "ok", markdown: newHeader + markdown.slice(header.length), changed: newHeader !== header, status: computed.status };
}
