# ナハト版AXAD

ナハト売上シートを、AXAD風の読み取り専用ダッシュボードとして表示する静的サイトです。

- 案件全体: `◆案件別日次_全体_固定用`
- 媒体別展開: `◆案件/媒体別日次_全体`

## 確認アカウント

ナハトシートは `pino.ad.kanri@shibuya-ad.com` のChromeプロファイルで閲覧します。

## 初期スコープ

- Cloudflare Pagesで公開し、Cloudflare Accessで `@shibuya-ad.com` / `@axis-company.jp` のGoogleアカウントのみ閲覧許可
- ホーム / マイページのみ
- CP検索なし
- 操作系なし
- 表示指標は売上、粗利、消化、CV、ROAS、CPA
- 反映済み期間は `data/index.json` の月一覧を参照
- 毎日 12:00 / 15:00 / 18:00 JST にGoogle Sheets APIから取り込み
- 月初は毎月1日、土日祝日の場合は翌平日、15:00 JST に新しい対象月を追加

## 公開・認証

本番公開はCloudflare Pagesを使います。GitHub PagesはCloudflare Accessを迂回できる直URLになるため使いません。

Cloudflare側の設定:

1. Cloudflare PagesでこのGitHubリポジトリを接続する
2. Build commandは `exit 0`、Output directoryは `.` にする
3. Cloudflare AccessでPagesの公開URLを対象にしたApplicationを作成する
4. 認証プロバイダにGoogleを設定する
5. Allow policyで `@shibuya-ad.com` / `@axis-company.jp` のメールドメインのみ許可する
6. KV namespaceを作成し、PagesのFunctions bindingに `ACTIVE_USERS` という名前で紐付ける
7. GitHub Settings > Pagesで既存のGitHub Pages公開を停止する

アプリ内のログイン前画面はUIとして残しています。本当の閲覧制限はCloudflare Accessで行います。

ログイン中ユーザー一覧はCloudflare Pages FunctionsとKVで管理します。各ブラウザが30秒ごとに
`/api/active-users` へ最終アクセス時刻を送信し、直近5分以内にheartbeatがあったユーザーを
オンラインとして表示します。

## データ更新

GitHub Actionsで `scripts/update-month-from-sources.mjs` を実行します。

自動化の方針:

- 正の参照元は `ナハト売上表` の管理シートです
- Chatwork「【分析】運用データ共有」のtoall周知は補助参照です
- 日次更新は前日が属する月のナハトシート全体を再取得します
- 月初更新は当月のナハトシートを検出し、サイト上の月選択に `20XX年XX月` を追加します
- ブラウザ操作は自動化に使わず、Google Sheets API / Chatwork APIで取得します

必要なGitHub Secret:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `GOOGLE_SERVICE_ACCOUNT_JSON` 任意。シート側でサービスアカウントに閲覧権限を付与できる場合のフォールバックです
- `CHATWORK_API_TOKEN` 任意。Chatwork補助参照と通知fallbackに使います
- `CHATWORK_ANALYSIS_ROOM_ID` 任意。「【分析】運用データ共有」のroom_idです
- `CLOUDFLARE_ACCOUNT_ID` 任意。Cloudflare Pagesのデプロイ状態チェックに使います
- `CLOUDFLARE_API_TOKEN` 任意。Cloudflare Pagesのデプロイ状態チェックに使います
- `CLOUDFLARE_PAGES_PROJECT_NAME` 任意。未設定時は `nahato-axad-dashboard` を使います
- `SMTP_HOST` 任意。失敗通知メールのSMTPサーバーです
- `SMTP_PORT` 任意。失敗通知メールのSMTPポートです。未設定時のスクリプト既定値は `465` です
- `SMTP_USERNAME` 任意。失敗通知メールのSMTPユーザー名です
- `SMTP_PASSWORD` 任意。失敗通知メールのSMTPパスワードです
- `SMTP_FROM` 任意。失敗通知メールのFromアドレスです
- `PRODUCTION_URL` 任意。本番疎通チェック対象URLです。未設定時は `https://nahato-axad-dashboard.pages.dev/#home` を使います
- `PRODUCTION_CHECK_REQUIRE_200` 任意。`true` の場合、本番URLがHTTP 200以外なら失敗扱いにします

通常は `pino.ad.kanri@shibuya-ad.com` のOAuth Refresh TokenでGoogle Sheets APIを読み込みます。
対象ナハトシートをサービスアカウントに共有できない場合でも、pinoアカウントがブラウザで閲覧できるシートであればAPI取得できます。

OAuth Refresh Tokenの作成:

1. Google Cloud ConsoleでOAuthクライアントを作成する
   - 種類: デスクトップアプリ、またはリダイレクトURIに `http://127.0.0.1:8765/oauth2callback` を許可したWebアプリ
   - スコープ: `https://www.googleapis.com/auth/spreadsheets.readonly`
2. 下記をローカルで実行する

```bash
GOOGLE_OAUTH_CLIENT_ID="..." \
GOOGLE_OAUTH_CLIENT_SECRET="..." \
node scripts/create-google-oauth-token.mjs
```

3. 表示されたURLを `pino.ad.kanri@shibuya-ad.com` のChromeプロファイルで開いて許可する
4. ターミナルに表示された `GOOGLE_OAUTH_REFRESH_TOKEN` をGitHub Secretsに登録する

`GOOGLE_OAUTH_*` がすべて設定されている場合はOAuthを優先します。未設定の場合のみ、従来通り `GOOGLE_SERVICE_ACCOUNT_JSON` を使います。

管理シート:

- Spreadsheet ID: `1Xk-p_-6Np-e5keqOy5fcgmU-TF28H5dU7UeEYDUX_7k`
- gid: `2127655846`

スケジュール:

- `0 3 * * *`: 12:00 JST
- `0 6 * * *`: 15:00 JST。日次更新に加えて、月初営業日なら当月タブを追加
- `0 9 * * *`: 18:00 JST
- `7 3 * * *`: 12:07 JST。GitHub Actionsの定刻発火漏れ対策用バックアップ
- `7 6 * * *`: 15:07 JST。同上
- `7 9 * * *`: 18:07 JST。同上
- `17/27 3,6,9 * * *`: 12:17 / 12:27 / 15:17 / 15:27 / 18:17 / 18:27 JST。同上
- `37/47/57 3,6,9 * * *`: 定時更新が作成されなかった場合の監視・再起動判定

GitHub ActionsのscheduleはUTCで実行されます。また、毎時0分は負荷集中により遅延または実行されない場合があるため、定刻は維持したまま複数のバックアップ更新と監視を走らせます。

リトライ:

- Google Sheets / Chatwork からの吸い上げに失敗した場合、同じGitHub Actions内で5分おきに2回まで再実行します
- 初回を含めて最大3回実行し、途中で成功した場合は成功扱いにします
- 3回すべて失敗した場合のみ、最終ステータスとして `data/update-status.json` に `error` を反映し、サイト上に `⚠️日次更新エラー` / `⚠️月初更新エラー` を表示します

更新後チェック:

- `◆全体売上表` は `A3:ZZ55` を取得し、取得行数が不足している場合は更新失敗にします
- 取得したGoogle Sheetsの表示値と `data/overall-sales-YYYY-MM.json` に書き込んだ値をセル単位で照合し、差分があれば更新失敗にします
- `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` が設定されている場合、mainへのpush後と更新コミット後にCloudflare Pagesの該当commitがデプロイ成功するか最大10分確認します
- CloudflareのSecretが未設定の場合、デプロイ状態チェックは `warning` として扱い、データ更新自体は止めません
- 本番URLがHTTP 200で取得できる場合、HTML内の主要assetもHTTP 200で読み込めるか確認します
- Cloudflare Accessなどで本番URLが `302` / `401` / `403` になる場合は、既定では `warning` として扱います
- `SMTP_*` が設定されている場合、更新失敗・検証失敗・デプロイ確認失敗・定時監視による再実行起動を `matsuzaki@shibuya-ad.com` にメール通知します
- `SMTP_*` が未設定または送信失敗した場合、`CHATWORK_API_TOKEN` があればマイチャット `398449612` へ通知します
- Google OAuthの `invalid_grant` / `invalid_client` / `unauthorized_client` はサービスアカウントで隠さず失敗扱いにし、再作成が必要なSecretをエラーメッセージに出します
- `◆案件/媒体別日次_全体` / `◆案件別日次_全体_固定用` / `◆全体売上表` は、合計行・日付ヘッダー・売上/粗利/消化金額/ROASの構造が崩れた場合に更新失敗にします
- GitHub Actionsのpushチェックが実行前に `cancelled` になった場合、10分おきの監視で最大3回まで再実行します
- GitHub Actionsのpushチェックが25分以上 `queued` のままなら、一度cancelして次回監視で再実行対象にします

手動実行:

- `mode=daily`: 前日が属する月を更新
- `mode=monthly`: 当月を追加・更新
- `mode=all`: 日次更新と月初更新を両方実行
- `month=YYYY-MM`: 指定月だけ更新
- `spreadsheet_id`: 指定したナハトシートIDを直接更新
- `force_monthly=true`: 月初営業日判定を無視してmonthly/allを実行

手動復旧:

1. GitHub Actionsで `Update Nacht AXAD data` を開く
2. `Run workflow` から `mode=daily` を選び実行する
3. 特定月だけ直す場合は `month=YYYY-MM` を指定する
4. 対象シートを固定したい場合は `spreadsheet_id` にナハトシートIDを入れる
5. `Validate Nacht AXAD static data` と `Check Cloudflare Pages deploy` が `success` になるまで確認する
6. `google_oauth_invalid_grant` が出た場合は `pino.ad.kanri@shibuya-ad.com` でRefresh Tokenを再作成し、`GOOGLE_OAUTH_REFRESH_TOKEN` を更新する
7. `sheet_structure_changed` が出た場合は、対象ナハトシートのタブ名・合計行・日付列・売上/粗利/消化金額/ROAS行を確認する
8. `production_url_non_200` が出た場合は、Cloudflare Pagesの最新デプロイ、Access設定、`PRODUCTION_URL` を確認する

## ローカル確認

```bash
npm run test:parser
npm run test:schedule
npm start
```

ブラウザで `http://localhost:4173` を開きます。

## データ形

Google Sheetsの `◆案件別日次_全体_固定用` と `◆案件媒体別日次_全体` を以下に正規化します。

```json
{
  "date": "2026-06-01",
  "project": "カーブス",
  "media": "FB",
  "sales": 600000,
  "grossProfit": 39086,
  "cost": 560914,
  "cv": 30,
  "roas": 1.0697,
  "cpa": 18697.133333333335
}
```

サイト側では、媒体が `全体` の行を全体集計に使い、媒体別表示では `FB / YT / LAP` などの明細行を使います。

## 履歴データ

履歴月は `ナハト売上表` のリンク集を元に、xlsxエクスポートから取り込んでいます。

- 2022年11月以降を反映
- 2024年6月以前など媒体別タブがない月は、案件全体のみを反映
- 2026年1月は固定用タブの粗利が全件0のため、媒体別タブ内の案件全体行を採用
- 2022年1月〜9月はpino Chromeでxlsxが取得できず未反映
- 2022年10月は元シートの数式が `#REF!` で実績値を取得できず未反映
