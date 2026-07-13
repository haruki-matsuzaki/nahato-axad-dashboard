import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const output = execFileSync(process.execPath, ["scripts/send-chatwork-alert.mjs", "--dryRun", "--reason", "update_failed"], {
  encoding: "utf8",
  env: { ...process.env, CHATWORK_API_TOKEN: "" },
});
const result = JSON.parse(output);
assert.equal(result.status, "ok");
assert.equal(result.channel, "chatwork");
assert.equal(result.dryRun, true);
assert.match(result.subject, /日次更新エラー/);
assert.equal(Object.hasOwn(result, "to"), false);

const files = [
  ".github/workflows/update-data.yml",
  ".github/workflows/monitor-update.yml",
  ".github/workflows/retry-cancelled-checks.yml",
  ".github/workflows/check-deploy.yml",
  "scripts/check-automation-secrets.mjs",
  "package.json",
];
for (const filePath of files) {
  const text = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(text, /SMTP_|ALERT_EMAIL|send-alert-email/);
}

console.log("Chatwork-only alert tests ok");
