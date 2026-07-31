import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowDailyUpdateError } from "../assets/update-alert-state.js";

test("does not show the daily update error for a historical month", () => {
  assert.equal(
    shouldShowDailyUpdateError({
      selectedMonth: "2026-04",
      targetMonth: "2026-07",
      status: "error",
      stale: true,
      hasFreshData: false,
    }),
    false,
  );
});

test("shows the daily update error for the active update target month", () => {
  assert.equal(
    shouldShowDailyUpdateError({
      selectedMonth: "2026-07",
      targetMonth: "2026-07",
      status: "ok",
      stale: true,
      hasFreshData: false,
    }),
    true,
  );
});

test("hides the daily update error when target-month data is fresh", () => {
  assert.equal(
    shouldShowDailyUpdateError({
      selectedMonth: "2026-07",
      targetMonth: "2026-07",
      status: "error",
      stale: true,
      hasFreshData: true,
    }),
    false,
  );
});
