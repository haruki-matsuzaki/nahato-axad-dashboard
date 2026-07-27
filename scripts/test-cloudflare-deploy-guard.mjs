import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/update-data.yml", "utf8");
const deployCheck = fs.readFileSync("scripts/check-cloudflare-pages-deploy.mjs", "utf8");

assert.match(workflow, /echo "data_changed=false" >> "\$GITHUB_OUTPUT"/);
assert.match(workflow, /echo "data_changed=true" >> "\$GITHUB_OUTPUT"/);
assert.match(
  workflow,
  /steps\.commit-data\.outputs\.data_changed == 'true'/,
  "Cloudflare Pages verification must only run after a data-changing commit",
);
assert.match(
  deployCheck,
  /createFetchWithRetry/,
  "Cloudflare Pages API checks must retry transient HTTP and transport failures",
);

console.log("Cloudflare deploy guard tests ok");
