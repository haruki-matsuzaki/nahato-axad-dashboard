const JST_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const ERROR_GUIDES = {
  google_oauth_refresh_token_expired_or_revoked: {
    cause: "Google認証の更新トークンが期限切れ、取り消し、または認証情報との組み合わせ不一致になっています。",
    action: "Google OAuthの認証をやり直し、GitHub SecretsのGOOGLE_OAUTH_REFRESH_TOKENを更新してください。",
  },
  google_oauth_client_mismatch: {
    cause: "Google OAuthのクライアントIDとクライアントシークレットが一致していません。",
    action: "GCPで使用中のOAuthクライアントを確認し、GitHub SecretsのIDとシークレットを同じクライアントの値へそろえてください。",
  },
  google_oauth_client_unauthorized: {
    cause: "Google OAuthクライアントに必要な利用権限がありません。",
    action: "GCPのOAuth同意画面、対象ユーザー、Google Sheets APIの有効化状態を確認してください。",
  },
  google_service_account_error: {
    cause: "Googleサービスアカウントの設定値が不足しているか、秘密鍵を読み込めませんでした。",
    action: "GitHub SecretsのGOOGLE_SERVICE_ACCOUNT_JSONが有効なJSONか確認し、必要に応じて鍵を再発行してください。",
  },
  automation_configuration_error: {
    cause: "自動更新に必要なGoogle、Chatwork、またはCloudflareの設定値を確認できませんでした。",
    action: "GitHub Actionsの技術詳細を開き、未登録または無効と表示されたGitHub Secretを確認してください。",
  },
  sheet_fetch_failed: {
    cause: "Googleスプレッドシートの取得またはサイト用データへの変換中に処理が停止しました。保存された情報だけでは詳細原因を自動判定できませんでした。",
    action: "確認先のGitHub Actionsを開き、「Googleスプレッドシート取得」工程の末尾にあるエラー原文を確認してください。",
  },
  sheet_permission_or_missing: {
    cause: "対象のGoogleスプレッドシートを参照できません。閲覧権限不足、シート削除、またはURL・ID変更の可能性があります。",
    action: "自動更新で使用しているGoogleアカウントに閲覧権限があるか、対象シートが存在するか確認してください。",
  },
  sheet_structure_changed: {
    cause: "元シートのタブ名、日付見出し、合計行、または指標名が想定している配置から変わっています。",
    action: "元シートの構成変更を確認し、必要なら読み込み設定を新しい配置へ合わせてください。",
  },
  source_sheet_mismatch: {
    cause: "Googleスプレッドシートの取得値と、サイト用に生成したデータの照合結果が一致しませんでした。",
    action: "GitHub Actionsの技術詳細で差分対象を確認し、元シートの重複・途中追加・数式エラーを確認してください。",
  },
  sheet_source_guard_error: {
    cause: "対象月やタブ名を安全に特定できない、または取得範囲の上限に達したため、誤ったシートの取り込みを停止しました。",
    action: "対象月のシート名、必須タブ、データ最終行・最終列、同月シートの重複を確認してください。",
  },
  data_quality_error: {
    cause: "取り込んだデータに欠落、重複、または合計値との不一致が見つかりました。",
    action: "データ品質チェックの対象月・案件・日付を確認し、元シートまたは変換処理の差分を修正してください。",
  },
  static_validation_error: {
    cause: "サイト用JSONの形式、必須項目、または参照関係の検証に失敗しました。",
    action: "GitHub Actionsの技術詳細で検証エラー対象を確認し、生成データを修正してから再実行してください。",
  },
  cloudflare_deploy_failed: {
    cause: "Cloudflare Pagesへの公開完了を確認できませんでした。",
    action: "Cloudflare Pagesのデプロイ履歴を確認し、失敗している場合は再デプロイしてください。",
  },
  production_site_failed: {
    cause: "公開サイトへ正常にアクセスできない、または更新内容の反映を確認できませんでした。",
    action: "公開サイトとCloudflare Pagesの状態を確認し、デプロイ完了後に再確認してください。",
  },
  schedule_missing: {
    cause: "予定時刻を過ぎてもGitHub Actionsの定時更新が開始されませんでした。",
    action: "監視処理が再実行を起動済みです。確認先のGitHub Actionsで再実行結果を確認してください。",
  },
  workflow_dispatch_failed: {
    cause: "監視処理は更新漏れを検知しましたが、GitHub Actionsの再実行を開始できませんでした。GitHub APIの拒否、権限不足、または実行履歴未作成の可能性があります。",
    action: "確認先の監視ワークフローで技術詳細を確認し、必要に応じてupdate-data.ymlを手動実行してください。",
  },
  workflow_run_failed: {
    cause: "自動更新処理が失敗しましたが、保存された情報だけでは原因を自動判定できませんでした。",
    action: "確認先のGitHub Actionsを開き、赤く表示された工程と末尾の技術詳細を確認してください。",
  },
};

const EXTERNAL_ISSUES = {
  expected_month_missing: {
    cause: "対象月のサイト用データが作成されていません。",
    action: "月初更新の実行結果と、対象月のナハトシート登録状況を確認してください。",
  },
  previous_day_missing_from_both_sources: {
    cause: "前日分の数値が、案件別日時と全体売上表の両方で確認できません。",
    action: "元シートに前日分が入力済みか確認し、入力済みなら日次更新を再実行してください。",
  },
  overall_sales_previous_day_missing: {
    cause: "案件別日時には前日分がありますが、全体売上表には前日分がありません。",
    action: "元シートの「◆全体売上表」で前日列の売上・粗利・消化金額を確認してください。",
  },
  detail_previous_day_missing: {
    cause: "全体売上表には前日分がありますが、案件別日時には前日分がありません。",
    action: "元シートの案件別・媒体別日次タブで前日分の案件データを確認してください。",
  },
  data_quality_error: {
    cause: "公開データの品質チェックでエラーが残っています。",
    action: "GitHub Actionsのデータ品質チェック結果を確認し、欠落・重複・合計差分を修正してください。",
  },
  production_deploy_stale: {
    cause: "GitHub上の更新データより、公開サイトのデータが古い状態です。",
    action: "Cloudflare Pagesの最新デプロイが成功しているか確認し、必要なら再デプロイしてください。",
  },
  external_monitor_request_failed: {
    cause: "外形監視がGitHubまたは公開サイトのデータを取得できませんでした。",
    action: "GitHub、Cloudflare、公開サイトの稼働状況を確認し、時間を置いて再実行してください。",
  },
};

export function buildAutomationAlertMessage(context, now = new Date()) {
  const code = classifyAutomationError(context);
  const guide = ERROR_GUIDES[code] || ERROR_GUIDES.workflow_run_failed;
  const isMonitorTrigger = context.reason === "schedule_monitor_triggered";
  const isMonitorFailure = context.reason === "schedule_monitor_failed";
  const failedSteps = getFailedStepLabels(context.stepOutcomes);
  const rawDetails = collectRawDetails(context);
  const target = getTargetLabel(context);
  const subjectLabel = {
    update_failed: "日次更新エラー",
    schedule_monitor_triggered: "定時更新を自動で再実行",
    schedule_monitor_failed: "定時更新の再実行起動エラー",
    deploy_failed: "公開確認エラー",
  }[context.reason] || "自動化通知";
  const whatHappened = isMonitorFailure
    ? `${target || "予定時刻"}の更新漏れを検知しましたが、再実行を開始できませんでした。`
    : isMonitorTrigger
    ? context.trigger?.reason === "schedule_missing"
      ? `${target || "予定時刻"}の定時更新が開始されなかったため、監視処理が再実行を起動しました。`
      : `${target || "予定時刻"}の定時更新が正常に完了しなかったため、監視処理が再実行を起動しました。`
    : context.reason === "deploy_failed"
      ? "更新内容を公開サイトへ反映できたことを確認できませんでした。"
      : `${target ? `${target}の` : ""}データ更新が正常に完了しませんでした。`;
  const impact = isMonitorFailure
    ? "自動復旧が完了していないため、サイトには直前の正常更新時点の数値が表示されています。"
    : isMonitorTrigger
    ? "再実行が完了するまで、サイトには直前の正常更新時点の数値が表示されます。"
    : context.reason === "deploy_failed"
      ? "元データの更新が成功していても、公開サイトには古い数値が表示されている可能性があります。"
      : "サイトには直前の正常更新時点の数値が表示され、最新分が未反映の可能性があります。";

  const lines = [
    "【何が起きたか】",
    whatHappened,
    "",
    "【影響】",
    impact,
    "",
    "【推定原因】",
    guide.cause,
    "",
    "【確認・対応】",
    guide.action,
  ];

  if (context.runUrl) lines.push("", "【確認先】", context.runUrl);

  lines.push(
    "",
    "【技術詳細】",
    `・発生日時: ${formatJst(now)}`,
    context.workflow ? `・処理名: ${context.workflow}` : null,
    failedSteps.length ? `・失敗工程: ${failedSteps.join("、")}` : null,
    target ? `・対象: ${target}` : null,
    `・自動判定コード: ${code}`,
    context.dispatchCode ? `・起動エラーコード: ${context.dispatchCode}` : null,
    context.repository ? `・リポジトリ: ${context.repository}` : null,
    context.sha ? `・コミット: ${context.sha.slice(0, 12)}` : null,
    context.runAttempt ? `・実行回数: ${context.runAttempt}回目` : null,
    ...rawDetails.map((detail) => `・エラー原文: ${sanitizeTechnicalDetail(detail)}`),
  );

  return {
    subject: `[AXAD ナハトシート版] ${subjectLabel}`,
    body: lines.filter((line) => line !== null && line !== undefined).join("\n"),
    code,
  };
}

export function buildExternalMonitorAlertMessage(health, options = {}) {
  const actionsUrl = options.actionsUrl || "https://github.com/haruki-matsuzaki/nahato-axad-dashboard/actions/workflows/update-data.yml";
  const issueCodes = Array.isArray(health?.issues) && health.issues.length ? health.issues : ["external_monitor_request_failed"];
  const guides = issueCodes.map((code) => EXTERNAL_ISSUES[code]).filter(Boolean);
  const causes = guides.length
    ? guides.map((guide) => guide.cause)
    : ["監視処理が異常を検知しましたが、保存された情報だけでは原因を自動判定できませんでした。"];
  const actions = [...new Set(guides.map((guide) => guide.action))];
  const date = health?.expectedDate || "前日";
  const detail = health?.detail || {};
  const overall = health?.overallSales || {};
  const lines = [
    "【何が起きたか】",
    `${date}分のデータが公開サイトへ正常に反映されたことを確認できませんでした。`,
    "",
    "【影響】",
    "サイトには直前の正常更新時点の数値が表示されている可能性があります。",
    "",
    "【推定原因】",
    ...causes.map((cause) => `・${cause}`),
    "",
    "【確認・対応】",
    ...(actions.length ? actions : ["確認先のGitHub Actionsを開き、日次更新の実行結果を確認してください。"]).map(
      (action) => `・${action}`,
    ),
    "",
    "【確認先】",
    actionsUrl,
    "",
    "【技術詳細】",
    `・発生日時: ${formatJst(health?.checkedAt || new Date())}`,
    `・対象日: ${date}`,
    `・検知コード: ${issueCodes.join(", ")}`,
    `・案件別データ: ${detail.hasData ? "あり" : "なし"}（${detail.records ?? 0}件・${detail.projects ?? 0}案件）`,
    `・全体売上表データ: ${overall.hasData ? "あり" : "なし"}`,
    health?.analysis ? `・エラー原文: ${sanitizeTechnicalDetail(health.analysis)}` : null,
  ];
  return {
    subject: "[AXAD ナハトシート版] 外部同期監視エラー",
    body: lines.filter((line) => line !== null && line !== undefined).join("\n"),
    issueCodes,
  };
}

export function classifyAutomationError(context) {
  if (context.reason === "schedule_monitor_failed") return "workflow_dispatch_failed";
  if (context.reason === "schedule_monitor_triggered" && context.trigger?.reason === "schedule_missing") return "schedule_missing";

  const failedSteps = getFailedStepKeys(context.stepOutcomes);
  const text = [
    context.reason,
    context.trigger?.reason,
    context.trigger?.analysis,
    context.dispatchCode,
    context.dispatchMessage,
    context.updateStatus?.daily?.message,
    context.updateStatus?.monthly?.message,
    context.updateStatus?.overallSales?.message,
    context.updateStatus?.lastRun?.fatalError?.message,
    ...(context.qualityStatus?.errors || []).map((item) => item?.message || item?.type),
  ]
    .filter(Boolean)
    .join(" ");

  if (/google_oauth_invalid_grant|invalid_grant/i.test(text)) return "google_oauth_refresh_token_expired_or_revoked";
  if (/google_oauth_invalid_client|invalid_client/i.test(text)) return "google_oauth_client_mismatch";
  if (/google_oauth_unauthorized_client|unauthorized_client/i.test(text)) return "google_oauth_client_unauthorized";
  if (/service account|GOOGLE_SERVICE_ACCOUNT_JSON|private_key/i.test(text)) return "google_service_account_error";
  if (/Google Sheets API (403|404)|permission|not found|requested entity was not found/i.test(text)) {
    return "sheet_permission_or_missing";
  }
  if (/Sheet structure changed|missing metric label|no date header|no blocks with ["“]?合計/i.test(text)) {
    return "sheet_structure_changed";
  }
  if (/source sheet audit|source_sheet_mismatch|SourceAuditError/i.test(text)) return "source_sheet_mismatch";
  if (/SheetSourceGuardError|safe row limit|final requested (?:row|column)|equally preferred Nacht sheet|Required sheet tab|title month/i.test(text)) {
    return "sheet_source_guard_error";
  }
  if (/data quality|quality|duplicate_record_key|missing_media_date|value_mismatch/i.test(text)) return "data_quality_error";
  if (failedSteps.includes("cloudflareDeploy")) return "cloudflare_deploy_failed";
  if (failedSteps.includes("productionSite")) return "production_site_failed";
  if (failedSteps.includes("validateData")) return "static_validation_error";
  if (failedSteps.includes("automationSecrets")) return "automation_configuration_error";
  if (failedSteps.includes("fetchData")) return "sheet_fetch_failed";
  if (context.reason === "deploy_failed") return "cloudflare_deploy_failed";
  if (context.trigger?.reason && ERROR_GUIDES[context.trigger.reason]) return context.trigger.reason;
  return "workflow_run_failed";
}

function getTargetLabel(context) {
  if (context.trigger?.expectedRunAtJst) return `${context.trigger.expectedRunAtJst} JST`;
  const month = context.updateStatus?.daily?.month || context.updateStatus?.monthly?.month || context.updateStatus?.overallSales?.month;
  return month ? `${month}分` : "";
}

function collectRawDetails(context) {
  const values = [
    context.trigger?.analysis,
    context.dispatchMessage,
    context.updateStatus?.daily?.message,
    context.updateStatus?.monthly?.message,
    context.updateStatus?.overallSales?.message,
    context.updateStatus?.lastRun?.fatalError?.message,
    ...(context.qualityStatus?.errors || []).slice(0, 3).map((item) => item?.message || item?.type),
  ]
    .filter(Boolean)
    .map((value) => String(value));
  return [...new Set(values)].slice(0, 5);
}

function getFailedStepKeys(outcomes = {}) {
  return Object.entries(outcomes)
    .filter(([, outcome]) => ["failure", "failed", "cancelled", "canceled"].includes(String(outcome || "").toLowerCase()))
    .map(([key]) => key);
}

function getFailedStepLabels(outcomes = {}) {
  const labels = {
    automationSecrets: "認証・設定確認",
    fetchData: "Googleスプレッドシート取得",
    validateData: "生成データ検証",
    cloudflareDeploy: "Cloudflare Pages公開確認",
    productionSite: "公開サイト確認",
    dispatchUpdate: "日次更新の再実行起動",
  };
  return getFailedStepKeys(outcomes).map((key) => labels[key] || key);
}

function formatJst(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "取得できませんでした";
  return `${JST_FORMATTER.format(date).replaceAll("/", "-")} JST`;
}

function sanitizeTechnicalDetail(value) {
  return String(value || "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[秘密鍵は非表示]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [非表示]")
    .replace(/\b(client_secret|refresh_token|access_token|CHATWORK_API_TOKEN|GOOGLE_OAUTH_CLIENT_SECRET)\b\s*[:=]\s*[^\s,}\]]+/gi, "$1=[非表示]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}
