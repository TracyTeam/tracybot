import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { History } from "../history/types";
import { buildAdr, defaultTitle } from "./buildAdr";
import { adrFileName, nextAdrNumber, resolveAdrDir, slugify, listAdrFiles } from "./files";
import { readAdrTaskletKey, refreshAdrStatus } from "./refresh";
import { computeTaskletStatus, taskletKey } from "./status";

type Entry = History["files"][number]["tasklets"][number];

const NOW = new Date("2026-10-13T10:00:00.000Z");

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "snap-1",
    model: "anthropic/claude-sonnet-5",
    name: "Add caching to the orders API",
    messages: [
      { stage: "build", type: "prompt", message: "Add caching to the orders API" },
      { stage: "build", type: "response", message: "Added an in-memory cache." },
    ],
    lines: [1, 2, 3],
    ghostLines: [],
    originCommitHash: "abc1234def",
    taskletId: "t1",
    sessionId: "s1",
    questions: [],
    taskletGeneratedAt: Date.UTC(2026, 7, 14, 9, 0, 0),
    agentSource: "opencode",
    ...over,
  };
}

const history = (files: { path: string; tasklets: Entry[] }[]): History => ({ id: "head", files });

describe("computeTaskletStatus", () => {
  test("a committed tasklet whose code is in use is accepted", () => {
    const s = computeTaskletStatus(history([{ path: "a.ts", tasklets: [entry()] }]), "t1")!;
    assert.equal(s.status, "accepted");
    assert.equal(s.liveLines, 3);
    assert.equal(s.overwrittenLines, 0);
    assert.deepEqual(s.supersededBy, []);
  });

  test("an uncommitted tasklet whose code is in use is proposed", () => {
    const s = computeTaskletStatus(history([{ path: "a.ts", tasklets: [entry({ originCommitHash: undefined })] }]), "t1")!;
    assert.equal(s.status, "proposed");
    assert.equal(s.committed, false);
  });

  test("a tasklet with no lines left in use is superseded by whoever owns those lines now", () => {
    const old = entry({ lines: [], ghostLines: [1, 2, 3] });
    const newer = entry({ id: "snap-2", taskletId: "t2", name: "Switch to Redis", lines: [1, 2, 3] });
    const s = computeTaskletStatus(history([{ path: "a.ts", tasklets: [old, newer] }]), "t1")!;

    assert.equal(s.status, "superseded");
    assert.deepEqual(s.supersededBy, [{ key: "t2", name: "Switch to Redis" }]);
  });

  test("a tasklet that is only partly overwritten stays accepted, and the counts say how much survives", () => {
    const old = entry({ lines: [1], ghostLines: [2, 3] });
    const newer = entry({ id: "snap-2", taskletId: "t2", lines: [2, 3] });
    const s = computeTaskletStatus(history([{ path: "a.ts", tasklets: [old, newer] }]), "t1")!;

    assert.equal(s.status, "accepted");
    assert.equal(s.liveLines, 1);
    assert.equal(s.overwrittenLines, 2);
    assert.deepEqual(s.supersededBy, [], "only reported once nothing is left");
  });

  test("superseded with nobody owning the old lines (removed or rewritten by hand) names no successor", () => {
    const old = entry({ lines: [], ghostLines: [1, 2] });
    const s = computeTaskletStatus(history([{ path: "a.ts", tasklets: [old] }]), "t1")!;
    assert.equal(s.status, "superseded");
    assert.deepEqual(s.supersededBy, []);
  });

  test("being fully overwritten beats being uncommitted", () => {
    const old = entry({ originCommitHash: undefined, lines: [], ghostLines: [1] });
    const s = computeTaskletStatus(history([{ path: "a.ts", tasklets: [old] }]), "t1")!;
    assert.equal(s.status, "superseded");
  });

  test("counts and successors are combined across every file the tasklet touched", () => {
    const aOld = entry({ lines: [], ghostLines: [1] });
    const bOld = entry({ lines: [], ghostLines: [5, 6] });
    const aNew = entry({ id: "s2", taskletId: "t2", name: "Rewrite A", lines: [1] });
    const bNew = entry({ id: "s3", taskletId: "t3", name: "Rewrite B", lines: [5, 6] });
    const dupNew = entry({ id: "s2", taskletId: "t2", name: "Rewrite A", lines: [9] });
    const s = computeTaskletStatus(history([
      { path: "a.ts", tasklets: [aOld, aNew] },
      { path: "b.ts", tasklets: [bOld, bNew, dupNew] },
    ]), "t1")!;

    assert.equal(s.overwrittenLines, 3);
    assert.deepEqual(s.supersededBy.map(x => x.key).sort(), ["t2", "t3"]);
  });

  test("an unknown tasklet has no status, and a missing taskletId falls back to the snapshot id", () => {
    const h = history([{ path: "a.ts", tasklets: [entry({ taskletId: undefined, id: "snap-9" })] }]);
    assert.equal(computeTaskletStatus(h, "nope"), undefined);
    assert.equal(taskletKey(h.files[0].tasklets[0]), "snap-9");
    assert.equal(computeTaskletStatus(h, "snap-9")!.status, "accepted");
  });
});

describe("buildAdr", () => {
  const build = (h: History, title = "Cache the orders API") => buildAdr(h, "t1", { title, now: NOW })!;
  const one = (over: Partial<Entry> = {}) => history([{ path: "src/api.ts", tasklets: [entry(over)] }]);

  test("front matter carries the computed status and where the record came from", () => {
    const { markdown } = build(one());
    assert.match(markdown, /^---\nstatus: accepted\ndate: 2026-08-14\ndecision-makers: TODO\n/);
    assert.match(markdown, /tracybot-tasklet: "t1"\n/);
    assert.match(markdown, /tracybot-status-basis: "3 of 3 lines still in use \(checked 2026-10-13\)"\n/);
    assert.match(markdown, /tracybot-agent: opencode\n/);
    assert.match(markdown, /tracybot-model: "anthropic\/claude-sonnet-5"\n/);
    assert.match(markdown, /tracybot-session: "s1"\n/);
    assert.match(markdown, /tracybot-commit: abc1234def\n/);
    assert.match(markdown, /\n# Cache the orders API\n/);
  });

  test("the human-only sections are left as TODOs", () => {
    const { markdown } = build(one());
    for (const section of ["Decision Drivers", "Considered Options", "Decision Outcome", "Consequences", "Pros and Cons of the Options"]) {
      assert.ok(markdown.includes(section), `missing ${section}`);
    }
    assert.ok((markdown.match(/TODO/g) ?? []).length >= 6);
  });

  test("the request and the AI's answer are quoted, so the user's own markdown can't restructure the ADR", () => {
    const { markdown } = build(one({
      messages: [
        { stage: "build", type: "prompt", message: "# Big heading\n- a list\n\nsecond paragraph" },
        { stage: "build", type: "response", message: "Done." },
      ],
    }));
    assert.match(markdown, /> \*\*You:\*\* # Big heading\n> - a list\n>\n> second paragraph/);
    assert.ok(!/^# Big heading/m.test(markdown), "must not become a real heading");
  });

  test("code blocks and local paths are removed before anything is written", () => {
    const { markdown } = build(one({
      messages: [
        { stage: "build", type: "prompt", message: "Look at /Users/esme/secret-project/src/app.ts" },
        { stage: "build", type: "response", message: "Here:\n```ts\nconst apiKey = 'sk-123'\n```\nDone." },
      ],
    }));
    assert.ok(!markdown.includes("esme"), "home directory leaked");
    assert.ok(!markdown.includes("secret-project"));
    assert.ok(!markdown.includes("sk-123"), "code block leaked");
    assert.ok(markdown.includes("[code omitted]") && markdown.includes("<path omitted>"));
  });

  test("long messages are shortened", () => {
    const { markdown } = build(one({
      messages: [{ stage: "build", type: "prompt", message: "word ".repeat(500) }, { stage: "build", type: "response", message: "ok" }],
    }));
    assert.ok(markdown.includes(" …"));
    assert.ok(markdown.length < 4000);
  });

  test("earlier discussion (plan) is included, capped, and says how much was left out", () => {
    const plan = Array.from({ length: 5 }, (_, i) => [
      { stage: "plan" as const, type: "prompt" as const, message: `question ${i}` },
      { stage: "plan" as const, type: "response" as const, message: `answer ${i}` },
    ]).flat();
    const { markdown } = build(one({ messages: [...plan, { stage: "build", type: "prompt", message: "do it" }] }));

    assert.ok(markdown.includes("**Earlier discussion**"));
    assert.ok(markdown.includes("question 0") && markdown.includes("question 2"));
    assert.ok(!markdown.includes("question 4"), "capped at 6 messages");
    assert.match(markdown, /\(4 more discussion messages not shown\)/);
  });

  test("questions the AI asked become the considered options, with the chosen one marked", () => {
    const { markdown } = build(one({
      questions: [{
        question: "Which pagination style should the API use?",
        header: "Pagination",
        options: [
          { label: "Offset", description: "Simple, slow on deep pages" },
          { label: "Cursor", description: "Stable under inserts" },
        ],
        answer: ["Cursor"],
        outputId: "o1",
      }],
    }));

    assert.match(markdown, /### Pagination\n\nWhich pagination style should the API use\?\n\n- Offset — Simple, slow on deep pages\n- Cursor — Stable under inserts \*\*\(chosen\)\*\*/);
    assert.match(markdown, /## Decision Outcome\n\nAs answered during the session:\n\n- Pagination: \*\*Cursor\*\*/);
  });

  test("a free-text answer that isn't one of the options is still shown", () => {
    const { markdown } = build(one({
      questions: [{ question: "Which store?", header: "", options: [{ label: "Redis", description: "" }], answer: ["Memcached"], outputId: "o1" }],
    }));
    assert.match(markdown, /- Memcached \*\*\(chosen, custom answer\)\*\*/);
  });

  test("with no recorded questions the section says why, differently for OpenCode and the other agents", () => {
    assert.match(build(one({ agentSource: "opencode" })).markdown, /No questions were asked during this tasklet\./);
    assert.match(build(one({ agentSource: "claude-code" })).markdown, /only OpenCode records the questions/);
  });

  test("the evidence table has one row per file with lines in use and overwritten", () => {
    const h = history([
      { path: "src/a.ts", tasklets: [entry({ lines: [1, 2], ghostLines: [3] })] },
      { path: "src/we|ird.ts", tasklets: [entry({ lines: [4], ghostLines: [] })] },
    ]);
    const { markdown } = buildAdr(h, "t1", { title: "x", now: NOW })!;
    assert.match(markdown, /\| src\/a\.ts \| 2 \| 1 \|/);
    assert.match(markdown, /\| src\/we\\\|ird\.ts \| 1 \| 0 \|/);
  });

  test("a superseded tasklet records who replaced it", () => {
    const h = history([{ path: "a.ts", tasklets: [
      entry({ lines: [], ghostLines: [1, 2, 3] }),
      entry({ id: "s2", taskletId: "t2", name: "Switch to Redis", lines: [1, 2, 3] }),
    ] }]);
    const { markdown, status } = buildAdr(h, "t1", { title: "x", now: NOW })!;

    assert.equal(status.status, "superseded");
    assert.match(markdown, /^---\nstatus: superseded\n/);
    assert.match(markdown, /0 of 3 lines still in use; overwritten by \\"Switch to Redis\\"/);
  });

  test("the same input always gives the same output", () => {
    assert.equal(build(one()).markdown, build(one()).markdown);
  });

  test("an empty title falls back to one taken from the tasklet, and an unknown tasklet gives nothing", () => {
    assert.equal(buildAdr(one(), "t1", { title: "   ", now: NOW })!.title, "Add caching to the orders API");
    assert.equal(buildAdr(one(), "missing", { title: "x", now: NOW }), undefined);
  });

  test("ids with quotes or colons don't break the front matter", () => {
    const { markdown } = buildAdr(one({ taskletId: 'weird: "id"' }), 'weird: "id"', { title: "x", now: NOW })!;
    assert.equal(readAdrTaskletKey(markdown), 'weird: "id"');
  });
});

describe("defaultTitle", () => {
  test("uses the first line, strips markdown markers, and shortens", () => {
    assert.equal(defaultTitle({ name: "## Add   caching\nmore" }, "opencode"), "Add caching");
    assert.equal(defaultTitle({ name: "x".repeat(200) }, "opencode").length, 80);
    assert.equal(defaultTitle({ name: "  \n " }, "claude-code"), "Decision from claude-code tasklet");
    assert.equal(defaultTitle({ name: "https://example.com/some/page\n\nfix the bug it describes" }, "claude-code"), "fix the bug it describes");
    assert.equal(defaultTitle({ name: "https://example.com/only-a-link" }, "claude-code"), "Decision from claude-code tasklet");
  });
});

describe("ADR files", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); } });
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-adr-")); dirs.push(d); return d; };

  test("slugs are lowercase ascii with hyphens, and cut on a word boundary", () => {
    assert.equal(slugify("Use Cursor Pagination!"), "use-cursor-pagination");
    assert.equal(slugify("Café résumé"), "cafe-resume");
    assert.equal(slugify("数据库选择"), "");
    const long = slugify("use a message queue between the orders service and the billing service for reliability");
    assert.ok(long.length <= 50 && !long.endsWith("-"));
  });

  test("the next number is one past the highest existing ADR, ignoring other files", () => {
    const dir = tmp();
    for (const n of ["0001-a.md", "0007-b.md", "README.md", "notes.txt", "0003-c.md"]) { fs.writeFileSync(path.join(dir, n), ""); }
    assert.equal(nextAdrNumber(dir), 8);
    assert.equal(nextAdrNumber(path.join(dir, "does-not-exist")), 1);
  });

  test("file names are numbered, and a title with no latin letters falls back to the tasklet id", () => {
    assert.equal(adrFileName(7, "Use cursor pagination", "t1"), "0007-use-cursor-pagination.md");
    assert.equal(adrFileName(12, "数据库选择", "claude_sess_171234"), "0012-tasklet-claudese.md");
  });

  test("the ADR directory must stay inside the repository", () => {
    const repo = path.resolve("/repo");
    assert.equal(resolveAdrDir(repo, undefined), path.join(repo, "docs/adr"));
    assert.equal(resolveAdrDir(repo, "  "), path.join(repo, "docs/adr"));
    assert.equal(resolveAdrDir(repo, "doc/decisions"), path.join(repo, "doc/decisions"));
    assert.equal(resolveAdrDir(repo, "../outside"), undefined);
    assert.equal(resolveAdrDir(repo, "/etc"), undefined);
    assert.equal(resolveAdrDir(repo, "."), undefined);
  });

  test("only markdown files are listed", () => {
    const dir = tmp();
    for (const n of ["a.md", "b.txt", "c.MD"]) { fs.writeFileSync(path.join(dir, n), ""); }
    assert.deepEqual(listAdrFiles(dir).map(f => path.basename(f)), ["a.md", "c.MD"]);
  });
});

describe("refreshAdrStatus", () => {
  const written = (h: History) => buildAdr(h, "t1", { title: "Cache it", now: NOW })!.markdown;
  const live = () => history([{ path: "a.ts", tasklets: [entry()] }]);
  const gone = () => history([{ path: "a.ts", tasklets: [
    entry({ lines: [], ghostLines: [1, 2, 3] }),
    entry({ id: "s2", taskletId: "t2", name: "Switch to Redis", lines: [1, 2, 3] }),
  ] }]);
  const later = new Date("2026-12-01T00:00:00.000Z");

  test("only the status and basis lines change when the code has been overwritten", () => {
    const md = written(live()).replace("_TODO: say why this option was chosen._", "_TODO_").replace("## Decision Outcome\n\n_TODO: state the decision._", "## Decision Outcome\n\nWe chose a cache because it is simple.");
    const r = refreshAdrStatus(md, gone(), later);

    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") { return; }
    assert.equal(r.changed, true);
    assert.equal(r.status, "superseded");
    assert.match(r.markdown, /^---\nstatus: superseded\n/);
    assert.match(r.markdown, /tracybot-status-basis: "0 of 3 lines still in use; overwritten by \\"Switch to Redis\\" \(checked 2026-12-01\)"/);

    const body = (s: string) => s.slice(s.indexOf("\n---\n", 4));
    assert.equal(body(r.markdown), body(md), "everything after the front matter is untouched, byte for byte");
    assert.ok(r.markdown.includes("We chose a cache because it is simple."));
  });

  test("nothing is rewritten when only the date has moved on", () => {
    const md = written(live());
    const r = refreshAdrStatus(md, live(), later);
    assert.equal(r.kind === "ok" && r.changed, false);
    assert.equal(r.kind === "ok" && r.markdown, md);
  });

  test("an uncommitted tasklet becomes accepted once it is committed", () => {
    const md = written(history([{ path: "a.ts", tasklets: [entry({ originCommitHash: undefined })] }]));
    assert.match(md, /^---\nstatus: proposed\n/);

    const r = refreshAdrStatus(md, live(), later);
    assert.equal(r.kind === "ok" && r.status, "accepted");
    assert.match(r.kind === "ok" ? r.markdown : "", /^---\nstatus: accepted\n/);
  });

  test("a status a person set by hand is respected", () => {
    const md = written(live()).replace("status: accepted", "status: rejected");
    const r = refreshAdrStatus(md, gone(), later);
    assert.deepEqual(r, { kind: "manual-status", status: "rejected" });
  });

  test("files that aren't Tracybot ADRs, or whose tasklet is gone, are reported rather than changed", () => {
    assert.deepEqual(refreshAdrStatus("# Just a note\n", live(), later), { kind: "not-tracybot" });
    assert.deepEqual(refreshAdrStatus("---\ntitle: x\n---\nbody\n", live(), later), { kind: "not-tracybot" });
    assert.deepEqual(refreshAdrStatus(written(live()), history([]), later), { kind: "tasklet-missing", key: "t1" });
  });

  test("Windows line endings are preserved", () => {
    const md = written(live()).replace(/\n/g, "\r\n");
    const r = refreshAdrStatus(md, gone(), later);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") { return; }
    assert.ok(r.markdown.includes("status: superseded\r\n"));
    assert.ok(!/[^\r]\n/.test(r.markdown), "no bare LF introduced");
  });
});
