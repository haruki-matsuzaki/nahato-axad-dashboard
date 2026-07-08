# ナハト版AXAD

ナハト売上シートを、AXAD風の読み取り専用ダッシュボードとして表示する静的サイトです。

- 案件全体: `◆案件別日次_全体_固定用`
- 媒体別展開: `◆案件媒体別日次_全体`

## 確認アカウント

ナハトシートは `pino.ad.kanri@shibuya-ad.com` のChromeプロファイルで閲覧します。

## 初期スコープ

- Cloudflare Pagesで公開し、Cloudflare Accessで `@shibuya-ad.com` のGoogleアカウントのみ閲覧許可
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
5. Allow policyで `@shibuya-ad.com` のメールドメインのみ許可する
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

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `CHATWORK_API_TOKEN` 任意。Chatwork補助参照を使う場合だけ設定します
- `CHATWORK_ANALYSIS_ROOM_ID` 任意。「【分析】運用データ共有」のroom_idです

Google CloudのサービスアカウントJSONをそのまま入れます。シート側では、そのサービスアカウントの `client_email` に閲覧権限を付与してください。

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

GitHub ActionsのscheduleはUTCで実行されます。また、毎時0分は負荷集中により遅延または実行されない場合があるため、定刻は維持したまま7分後にも同じ更新を走らせます。

手動実行:

- `mode=daily`: 前日が属する月を更新
- `mode=monthly`: 当月を追加・更新
- `mode=all`: 日次更新と月初更新を両方実行
- `month=YYYY-MM`: 指定月だけ更新
- `spreadsheet_id`: 指定したナハトシートIDを直接更新
- `force_monthly=true`: 月初営業日判定を無視してmonthly/allを実行

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
