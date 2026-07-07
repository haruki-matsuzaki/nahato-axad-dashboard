# ナハト版AXAD

ナハト売上シートを、AXAD風の読み取り専用ダッシュボードとして表示する静的サイトです。

- 案件全体: `◆案件別日次_全体_固定用`
- 媒体別展開: `◆案件媒体別日次_全体`

## 確認アカウント

ナハトシートは `pino.ad.kanri@shibuya-ad.com` のChromeプロファイルで閲覧します。

## 初期スコープ

- GitHub Pagesで公開
- ホーム / マイページのみ
- CP検索なし
- 操作系なし
- 表示指標は売上、粗利、消化、CV、ROAS、CPA
- 反映済み期間は `data/index.json` の月一覧を参照
- 毎日 9:00 / 18:00 JST にGoogle Sheets APIから取り込み

## データ更新

GitHub Actionsで `scripts/update-data.mjs` を実行します。

必要なGitHub Secret:

- `GOOGLE_SERVICE_ACCOUNT_JSON`

Google CloudのサービスアカウントJSONをそのまま入れます。シート側では、そのサービスアカウントの `client_email` に閲覧権限を付与してください。

## ローカル確認

```bash
npm run test:parser
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
