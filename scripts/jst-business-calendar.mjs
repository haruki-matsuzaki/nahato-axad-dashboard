const JST_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_BOOTSTRAP_READY_HOUR = 15;
const DEFAULT_BOOTSTRAP_READY_MINUTE = 30;

export function getMonthBootstrapState(
  date = new Date(),
  { readyHour = DEFAULT_BOOTSTRAP_READY_HOUR, readyMinute = DEFAULT_BOOTSTRAP_READY_MINUTE } = {},
) {
  const now = getJstDateTimeParts(date);
  const today = { year: now.year, month: now.month, day: now.day };
  const yesterday = addDays(today, -1);
  const targetMonth = monthId(yesterday);
  const currentMonth = monthId(today);
  const firstBusinessDate = firstBusinessDayOfMonth(today.year, today.month);
  const isNewMonthTarget = targetMonth === currentMonth;
  const beforeFirstBusinessDay = today.day < firstBusinessDate.day;
  const beforeReadyTime =
    today.day === firstBusinessDate.day && now.hour * 60 + now.minute < readyHour * 60 + readyMinute;
  const readyDate = { ...firstBusinessDate, hour: readyHour, minute: readyMinute };

  return {
    active: isNewMonthTarget && (beforeFirstBusinessDay || beforeReadyTime),
    targetMonth,
    firstBusinessDay: formatYmd(firstBusinessDate),
    readyAtJst: `${formatYmd(readyDate)} ${String(readyHour).padStart(2, "0")}:${String(readyMinute).padStart(2, "0")} JST`,
  };
}

export function getJstDateParts(date) {
  const parts = getJstDateTimeParts(date);
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function getJstHour(date) {
  return getJstDateTimeParts(date).hour;
}

export function addDays(parts, amount) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function monthId(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

export function formatYmd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function isFirstBusinessDay(parts) {
  if (!isBusinessDay(parts)) return false;
  return firstBusinessDayOfMonth(parts.year, parts.month).day === parts.day;
}

function getJstDateTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

function firstBusinessDayOfMonth(year, month) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const parts = { year, month, day };
    if (isBusinessDay(parts)) return parts;
  }
  throw new Error(`Business day not found for ${year}-${String(month).padStart(2, "0")}`);
}

function isBusinessDay(parts) {
  const weekday = weekdayOf(parts);
  if (weekday === 0 || weekday === 6) return false;
  return !japaneseHolidaySet(parts.year).has(formatYmd(parts));
}

function japaneseHolidaySet(year) {
  const holidays = new Set();
  addHoliday(holidays, year, 1, 1);
  addHoliday(holidays, year, 1, nthWeekdayOfMonth(year, 1, 1, 2));
  addHoliday(holidays, year, 2, 11);
  addHoliday(holidays, year, 2, 23);
  addHoliday(holidays, year, 3, vernalEquinoxDay(year));
  addHoliday(holidays, year, 4, 29);
  addHoliday(holidays, year, 5, 3);
  addHoliday(holidays, year, 5, 4);
  addHoliday(holidays, year, 5, 5);
  addHoliday(holidays, year, 7, nthWeekdayOfMonth(year, 7, 1, 3));
  addHoliday(holidays, year, 8, 11);
  addHoliday(holidays, year, 9, nthWeekdayOfMonth(year, 9, 1, 3));
  addHoliday(holidays, year, 9, autumnEquinoxDay(year));
  addHoliday(holidays, year, 10, nthWeekdayOfMonth(year, 10, 1, 2));
  addHoliday(holidays, year, 11, 3);
  addHoliday(holidays, year, 11, 23);

  for (const ymd of [...holidays].sort()) {
    const parts = parseYmd(ymd);
    if (weekdayOf(parts) !== 0) continue;
    let observed = addDays(parts, 1);
    while (holidays.has(formatYmd(observed))) observed = addDays(observed, 1);
    if (observed.year === year) holidays.add(formatYmd(observed));
  }

  for (let month = 1; month <= 12; month += 1) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 2; day < daysInMonth; day += 1) {
      const parts = { year, month, day };
      const ymd = formatYmd(parts);
      if (holidays.has(ymd) || weekdayOf(parts) === 0 || weekdayOf(parts) === 6) continue;
      if (holidays.has(formatYmd(addDays(parts, -1))) && holidays.has(formatYmd(addDays(parts, 1)))) {
        holidays.add(ymd);
      }
    }
  }

  return holidays;
}

function addHoliday(set, year, month, day) {
  set.add(formatYmd({ year, month, day }));
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  let count = 0;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (weekdayOf({ year, month, day }) !== weekday) continue;
    count += 1;
    if (count === nth) return day;
  }
  return 1;
}

function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function weekdayOf(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function parseYmd(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}
