import fs from "node:fs/promises";
import path from "node:path";

const indexPath = "data/index.json";

const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
const results = [];

for (const month of index.months || []) {
  const dataPath = month.path;
  const businessPath = `data/overall-business-sales-${month.id}.json`;
  if (!(await exists(dataPath)) || !(await exists(businessPath))) continue;

  const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
  const business = JSON.parse(await fs.readFile(businessPath, "utf8"));
  const backfilled = backfillMonth(data, business);
  if (!backfilled.addedRecords.length) continue;

  const next = {
    ...data,
    projects: [...new Set([...data.projects, ...backfilled.projects])].sort(localeSort),
    media: [...new Set([...data.media, ...backfilled.media])].sort(localeSort),
    warnings: [
      ...(data.warnings || []),
      `Backfilled ${backfilled.projects.length} project(s) from overall business sales: ${backfilled.projects.join(", ")}`,
    ],
    records: [...data.records, ...backfilled.addedRecords],
  };

  await writeJson(dataPath, next);
  results.push({
    month: month.id,
    projects: backfilled.projects,
    records: backfilled.addedRecords.length,
  });
}

console.log(JSON.stringify({ updated: results.length, results }, null, 2));

function backfillMonth(data, business) {
  const existingProjects = new Set((data.records || []).map((record) => normalize(record.project)));
  const columnIndexes = indexBusinessColumns(business.columns || []);
  if (!columnIndexes) return { projects: [], media: [], addedRecords: [] };

  const businessRows = business.rows || [];
  const nonzeroProjects = nonzeroBusinessProjects(businessRows, columnIndexes);
  const missingProjects = [...nonzeroProjects].filter((project) => !existingProjects.has(project));
  const rowsByKey = new Map();

  for (const row of businessRows) {
    const values = row.values || [];
    const project = normalize(values[columnIndexes.project]);
    if (!missingProjects.includes(project)) continue;
    const media = inferBusinessMedia(values, columnIndexes);
    const metric = canonicalMetricLabel(values[columnIndexes.metric]);
    if (!project || !media || !["売上", "粗利", "件数"].includes(metric)) continue;

    for (const dateColumn of columnIndexes.dateColumns) {
      const value = finiteNumber(values[dateColumn.valueIndex]);
      if (!value) continue;
      const key = `${project}\u0000${media}\u0000${dateColumn.date}`;
      const item = rowsByKey.get(key) || {
        date: dateColumn.date,
        project,
        media,
        sales: 0,
        grossProfit: 0,
        cost: 0,
        cv: 0,
        roas: 0,
        cpa: 0,
      };
      if (metric === "売上") item.sales += value;
      if (metric === "粗利") item.grossProfit += value;
      if (metric === "件数") item.cv += value;
      rowsByKey.set(key, item);
    }
  }

  const mediaRecords = [...rowsByKey.values()].map(finalizeRecord).filter(hasRecordValue);
  const totalRecords = synthesizeTotals(mediaRecords);
  const addedRecords = [...totalRecords, ...mediaRecords].sort(recordSort);

  return {
    projects: [...new Set(addedRecords.map((record) => record.project))].sort(localeSort),
    media: [...new Set(addedRecords.map((record) => record.media))].sort(localeSort),
    addedRecords,
  };
}

function indexBusinessColumns(columns) {
  const byKey = new Map(columns.map((column, index) => [column.key, index]));
  const required = ["media", "officialName", "metric"];
  if (!required.every((key) => byKey.has(key))) return null;
  const dateColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => /^\d{4}-\d{2}-\d{2}$/.test(column.key))
    .map(({ column, index }) => ({
      date: column.key,
      valueIndex: index,
    }));
  if (!dateColumns.length) return null;
  return {
    media: byKey.get("media"),
    detail: byKey.get("detail"),
    project: byKey.get("officialName"),
    metric: byKey.get("metric"),
    dateColumns,
  };
}

function nonzeroBusinessProjects(rows, columnIndexes) {
  const projects = new Set();
  for (const row of rows) {
    const values = row.values || [];
    const project = normalize(values[columnIndexes.project]);
    const metric = canonicalMetricLabel(values[columnIndexes.metric]);
    if (!project || !["売上", "粗利", "件数"].includes(metric)) continue;
    if (columnIndexes.dateColumns.some((dateColumn) => finiteNumber(values[dateColumn.valueIndex]) !== 0)) {
      projects.add(project);
    }
  }
  return projects;
}

function synthesizeTotals(records) {
  const totals = new Map();
  for (const record of records) {
    const key = `${record.project}\u0000${record.date}`;
    const total = totals.get(key) || {
      date: record.date,
      project: record.project,
      media: "全体",
      sales: 0,
      grossProfit: 0,
      cost: 0,
      cv: 0,
      roas: 0,
      cpa: 0,
    };
    total.sales += record.sales;
    total.grossProfit += record.grossProfit;
    total.cost += record.cost;
    total.cv += record.cv;
    totals.set(key, total);
  }
  return [...totals.values()].map(finalizeRecord).filter(hasRecordValue);
}

function finalizeRecord(record) {
  const cost = record.sales - record.grossProfit;
  const next = {
    ...record,
    cost,
    roas: cost ? record.sales / cost : 0,
    cpa: record.cv ? cost / record.cv : 0,
  };
  return next;
}

function hasRecordValue(record) {
  return [record.sales, record.grossProfit, record.cost, record.cv].some((value) => value !== 0);
}

function canonicalMetricLabel(value) {
  const label = normalize(value);
  if (["粗利", "利鞘", "利益"].includes(label)) return "粗利";
  if (label === "CV") return "件数";
  return label;
}

function canonicalMedia(value) {
  if (value === "YouTube") return "YT";
  if (value === "Meta") return "FB";
  return value;
}

function inferBusinessMedia(values, columnIndexes) {
  const explicit = canonicalMedia(normalize(values[columnIndexes.media]));
  if (explicit) return explicit;

  const detail = normalize(values[columnIndexes.detail]).toLowerCase();
  if (detail.includes("facebook") || detail.includes("_fb") || detail.includes("/fb")) return "FB";
  if (detail.includes("tiktok")) return "TikTok";
  if (detail.includes("youtube") || detail.includes("_yt") || detail.includes("/yt")) return "YT";
  if (detail.includes("pangle")) return "Pangle";
  if (detail.includes("line") || detail.includes("lap")) return "LINE";
  if (detail.includes("yahoo") || detail.includes("yda")) return "YDA";
  if (detail.includes("_x") || detail.includes("/x") || detail.endsWith(" x")) return "X";
  return "";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function recordSort(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    a.project.localeCompare(b.project, "ja") ||
    mediaRank(a.media) - mediaRank(b.media) ||
    a.media.localeCompare(b.media, "ja")
  );
}

function mediaRank(media) {
  if (media === "全体") return -1;
  return 0;
}

async function exists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function localeSort(a, b) {
  return String(a).localeCompare(b, "ja");
}
