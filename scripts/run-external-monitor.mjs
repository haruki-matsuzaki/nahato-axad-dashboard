import process from "node:process";
import { runLocalExternalMonitor } from "../cloudflare/update-monitor.js";

const result = await runLocalExternalMonitor(process.env);
console.log(
  JSON.stringify(
    {
      status: result.status,
      checkedAt: result.checkedAt || null,
      expectedDate: result.expectedDate || null,
      issues: result.issues || [],
    },
    null,
    2,
  ),
);

if (!new Set(["ok", "skipped"]).has(result.status)) process.exitCode = 1;
