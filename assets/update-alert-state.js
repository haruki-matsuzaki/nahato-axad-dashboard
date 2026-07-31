export function shouldShowDailyUpdateError({
  selectedMonth,
  targetMonth,
  status,
  stale,
  hasFreshData,
}) {
  return selectedMonth === targetMonth && (status === "error" || stale) && !hasFreshData;
}
