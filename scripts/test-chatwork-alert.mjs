import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { buildAutomationAlertMessage } from "./automation-alert-message.mjs";

const output = execFileSync(process.execPath, ["scripts/send-chatwork-alert.mjs", "--dryRun", "--reason", "update_failed"], {
  encoding: "utf8",
  env: { ...process.env, CHATWORK_API_TOKEN: "" },
});
const result = JSON.parse(output);
assert.equal(result.status, "ok");
assert.equal(result.channel, "chatwork");
assert.equal(result.dryRun, true);
assert.match(result.subject, /日次更新エラー/);
assert.match(result.body, /【何が起きたか】/);
assert.match(result.body, /【影響】/);
assert.match(result.body, /【推定原因】/);
assert.match(result.body, /【確認・対応】/);
assert.match(result.body, /【技術詳細】/);
assert.equal(Object.hasOwn(result, "to"), false);

const oauthError = buildAutomationAlertMessage(
  {
    reason: "update_failed",
    workflow: "Update Nacht AXAD data",
    runUrl: "https://github.com/example/actions/runs/123",
    stepOutcomes: { fetchData: "failure" },
    updateStatus: {
      daily: { month: "2026-07", message: "Google OAuth invalid_grant: Token has been expired or revoked." },
    },
    qualityStatus: { status: "ok", errors: [] },
  },
  new Date("2026-07-13T03:00:00.000Z"),
);
assert.equal(oauthError.code, "google_oauth_refresh_token_expired_or_revoked");
assert.match(oauthError.body, /Google認証の更新トークンが期限切れ/);
assert.match(oauthError.body, /Googleスプレッドシート取得/);
assert.match(oauthError.body, /エラー原文: Google OAuth invalid_grant/);
assert.match(oauthError.body, /2026-07-13 12:00:00 JST/);

const unknownError = buildAutomationAlertMessage({
  reason: "update_failed",
  updateStatus: { lastRun: { fatalError: { message: "Unexpected upstream response" } } },
});
assert.equal(unknownError.code, "workflow_run_failed");
assert.match(unknownError.body, /原因を自動判定できませんでした/);
assert.match(unknownError.body, /エラー原文: Unexpected upstream response/);

const fetchError = buildAutomationAlertMessage({
  reason: "update_failed",
  stepOutcomes: { fetchData: "failure" },
});
assert.equal(fetchError.code, "sheet_fetch_failed");
assert.match(fetchError.body, /Googleスプレッドシートの取得またはサイト用データへの変換中/);

const monitorTrigger = buildAutomationAlertMessage({
  reason: "schedule_monitor_triggered",
  trigger: {
    reason: "schedule_missing",
    expectedRunAtJst: "2026-07-13 12:00",
    analysis: "No scheduled update run was created.",
  },
});
assert.equal(monitorTrigger.code, "schedule_missing");
assert.match(monitorTrigger.body, /監視処理が再実行を起動しました/);
assert.match(monitorTrigger.body, /予定時刻を過ぎてもGitHub Actionsの定時更新が開始されませんでした/);

const monitorDispatchFailure = buildAutomationAlertMessage({
  reason: "schedule_monitor_failed",
  dispatchCode: "dispatch_permission_denied",
  dispatchMessage: "GitHub Actionsの起動リクエストが拒否されました（HTTP 403）。",
  stepOutcomes: { dispatchUpdate: "failure" },
  trigger: {
    reason: "schedule_missing",
    expectedRunAtJst: "2026-07-13 12:00",
    analysis: "No scheduled update run was created.",
  },
});
assert.equal(monitorDispatchFailure.code, "workflow_dispatch_failed");
assert.match(monitorDispatchFailure.subject, /再実行起動エラー/);
assert.match(monitorDispatchFailure.body, /再実行を開始できませんでした/);
assert.match(monitorDispatchFailure.body, /日次更新の再実行起動/);
assert.match(monitorDispatchFailure.body, /HTTP 403/);
assert.match(monitorDispatchFailure.body, /起動エラーコード: dispatch_permission_denied/);

const redactedError = buildAutomationAlertMessage({
  reason: "update_failed",
  updateStatus: { lastRun: { fatalError: { message: "refresh_token=do-not-show-this" } } },
});
assert.doesNotMatch(redactedError.body, /do-not-show-this/);
assert.match(redactedError.body, /refresh_token=\[非表示\]/);

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
