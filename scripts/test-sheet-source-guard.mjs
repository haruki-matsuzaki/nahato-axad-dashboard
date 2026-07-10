import assert from "node:assert/strict";
import {
  assertRangeCoverage,
  selectSourceForMonth,
  SheetSourceGuardError,
  validateSourceMetadata,
} from "./sheet-source-guard.mjs";

const safeRows = Array.from({ length: 2999 }, (_, index) => (index === 2998 ? ["last-safe-row"] : []));
const safeResult = assertRangeCoverage(safeRows, "A:ZZ", {
  spreadsheetId: "sheet-1",
  sheetName: "detail",
  safeMaxRows: 3000,
});
assert.equal(safeResult.lastPopulatedRow, 2999);

const overflowRows = [...safeRows, ["boundary-row"]];
assertGuardCode(
  () =>
    assertRangeCoverage(overflowRows, "A:ZZ", {
      spreadsheetId: "sheet-1",
      sheetName: "detail",
      safeMaxRows: 3000,
    }),
  "sheet_safe_row_limit_reached",
);

const finiteRows = Array.from({ length: 10 }, (_, index) => (index === 9 ? ["finite-boundary"] : []));
assertGuardCode(() => assertRangeCoverage(finiteRows, "A1:C10"), "sheet_range_row_boundary_reached");
assertGuardCode(
  () => assertRangeCoverage([["value", "", "column-boundary"]], "A:C"),
  "sheet_range_column_boundary_reached",
);

const source = {
  month: "2026-07",
  spreadsheetId: "sheet-1",
  title: "AD_総合売上管理表_2026年07月",
  sourceType: "master_sheet",
  sourceLabel: "ナハト売上表!14:6",
};
const metadata = {
  spreadsheetId: "sheet-1",
  properties: { title: source.title },
  sheets: [
    { properties: { title: "◆案件/媒体別日次_全体" } },
    { properties: { title: "◆案件別日次_全体_固定用" } },
  ],
};
const validated = validateSourceMetadata({
  metadata,
  source,
  expectedMonth: "2026-07",
  requiredSheetNames: ["◆案件/媒体別日次_全体", "◆案件別日次_全体_固定用"],
});
assert.equal(validated.titleMonth, "2026-07");

assertGuardCode(
  () =>
    validateSourceMetadata({
      metadata: { ...metadata, properties: { title: "AD_総合売上管理表_2026年06月" } },
      source: { ...source, title: "" },
      expectedMonth: "2026-07",
      requiredSheetNames: [],
    }),
  "spreadsheet_title_month_mismatch",
);
assertGuardCode(
  () =>
    validateSourceMetadata({
      metadata,
      source,
      expectedMonth: "2026-07",
      requiredSheetNames: ["◆案件/媒体別日次_全体", "missing-tab"],
    }),
  "required_sheet_missing",
);
assertGuardCode(
  () =>
    validateSourceMetadata({
      metadata: { ...metadata, spreadsheetId: "sheet-2" },
      source,
      expectedMonth: "2026-07",
      requiredSheetNames: [],
    }),
  "spreadsheet_id_mismatch",
);

const chatworkSource = {
  ...source,
  spreadsheetId: "chatwork-sheet",
  sourceType: "chatwork",
  sourceLabel: "message:1",
};
assert.equal(selectSourceForMonth([chatworkSource, source], "2026-07").spreadsheetId, "sheet-1");
assert.equal(
  selectSourceForMonth([source, { ...source, rowIndex: 20, sourceLabel: "ナハト売上表!21:6" }], "2026-07")
    .rowIndex,
  20,
);
assertGuardCode(
  () =>
    selectSourceForMonth(
      [source, { ...source, spreadsheetId: "sheet-2", sourceLabel: "ナハト売上表!15:6" }],
      "2026-07",
    ),
  "ambiguous_month_sources",
);

console.log("sheet source guard tests ok");

function assertGuardCode(action, expectedCode) {
  assert.throws(action, (error) => error instanceof SheetSourceGuardError && error.code === expectedCode);
}
