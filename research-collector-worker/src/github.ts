export interface WriteResult {
  ok: boolean;
  status: number;
}

// Writes a single file via GitHub's Contents API (one HTTP call, no local git
// clone/checkout needed server-side). Each submission's filename embeds its
// timestamp + tasklet_id, so this is always a create, never an update.
export async function writeFileToCollector(
  token: string,
  repo: string, // "owner/repo"
  filePath: string,
  content: string
): Promise<WriteResult> {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tracybot-research-collector",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `research: add ${filePath}`,
      // Buffer (via nodejs_compat) rather than btoa — content may contain
      // non-ASCII text (prompts written in any language), and btoa only
      // accepts Latin1 strings.
      content: Buffer.from(content, "utf-8").toString("base64"),
    }),
  });

  // 422 here means a file already exists at this exact path. Since the
  // filename is derived from (timestamp, tasklet_id), that only happens on a
  // genuine retry of the same submission — treat it as already-delivered
  // rather than a failure.
  if (response.status === 422) {
    return { ok: true, status: response.status };
  }

  return { ok: response.ok, status: response.status };
}
