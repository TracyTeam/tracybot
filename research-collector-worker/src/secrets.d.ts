// Secrets set via `wrangler secret put` — they don't appear in wrangler.jsonc,
// so `wrangler types` can't discover them. Declared here and merged by
// TypeScript into the ambient `Env` interface generated in
// worker-configuration.d.ts. Re-declare here (not there) since that file is
// regenerated every time `wrangler types` runs.
interface Env {
  SUBMIT_KEY: string;
  GITHUB_TOKEN: string;
}
