import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const errors = [];
const warnings = [];

async function main() {
  const index = await readRequiredJson("data/index.json");
  validateIndex(index);
  await validateRoutes();
  await validateUpdateStatus();
  await validateHtmlAssets();

  for (const month of index.months || []) {
    await validateMonth(month);
  }

  if (warnings.length) {
    console.warn(warnings.map((warning) => `WARN ${warning}`).join("\n"));
  }
  if (errors.length) {
    console.error(errors.map((error) => `ERROR ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`static data ok: ${index.months.length} months`);
}

async function validateRoutes() {
  const routes = await readRequiredJson("_routes.json");
  if (routes.version !== 1) errors.push("_routes.json: version must be 1");
  if (!Array.isArray(routes.include) || !routes.include.includes("/api/*")) {
    errors.push("_routes.json: include must contain /api/*");
  }
}

async function validateUpdateStatus() {
  const status = await readRequiredJson("data/update-status.json");
  for (const key of ["daily", "monthly"]) {
    if (!["ok", "error"].includes(status?.[key]?.status)) {
      errors.push(`data/update-status.json: ${key}.status must be ok or error`);
    }
  }
}

async function validateHtmlAssets() {
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  const scriptMatch = html.match(/<script[^>]+src="([^"]*assets\/app\.js[^"]*)"/);
  if (!scriptMatch) {
    errors.push("index.html: assets/app.js script tag is missing");
    return;
  }
  const scriptPath = scriptMatch[1].split("?")[0];
  await ensureFile(scriptPath, "index.html script");
}

function validateIndex(index) {
  if (!Array.isArray(index?.months) || !index.months.length) {
    errors.push("data/index.json: months must not be empty");
    return;
  }
  const ids = new Set();
  for (const month of index.months) {
    if (!month?.id || !month?.label || !month?.path) {
      errors.push("data/index.json: month entries require id, label, and path");
      continue;
    }
    if (ids.has(month.id)) errors.push(`data/index.json: duplicate month ${month.id}`);
    ids.add(month.id);
  }
  if (!ids.has(index.defaultMonth)) {
    errors.push(`data/index.json: defaultMonth ${index.defaultMonth} is not in months`);
  }
}

async function validateMonth(month) {
  const data = await readRequiredJson(month.path);
  if (data?.month && data.month !== month.id) {
    warnings.push(`${month.path}: month field is ${data.month}, expected ${month.id}`);
  }
  if (!Array.isArray(data?.records)) {
    errors.push(`${month.path}: records must be an array`);
    return;
  }
  for (const [index, record] of data.records.entries()) {
    if (!record?.date || !record?.project || !record?.media) {
      errors.push(`${month.path}: record ${index + 1} requires date, project, and media`);
      break;
    }
    for (const key of ["sales", "grossProfit", "cost", "cv", "roas", "cpa"]) {
      if (!Number.isFinite(Number(record[key]))) {
        errors.push(`${month.path}: record ${index + 1}.${key} must be numeric`);
        break;
      }
    }
  }

  await readOptionalJson(`data/overall-sales-${month.id}.json`);
  await readOptionalJson(`data/overall-business-sales-${month.id}.json`);
}

async function readRequiredJson(filePath) {
  try {
    const raw = await fs.readFile(path.join(root, filePath), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    errors.push(`${filePath}: ${error.message}`);
    return {};
  }
}

async function readOptionalJson(filePath) {
  try {
    const raw = await fs.readFile(path.join(root, filePath), "utf8");
    JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(`${filePath}: ${error.message}`);
  }
}

async function ensureFile(filePath, label) {
  try {
    const stat = await fs.stat(path.join(root, filePath));
    if (!stat.isFile()) errors.push(`${label}: ${filePath} is not a file`);
  } catch (error) {
    errors.push(`${label}: ${filePath}: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
