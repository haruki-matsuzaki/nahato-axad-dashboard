import process from "node:process";
import { runScheduledMonitor } from "../cloudflare/update-monitor.js";

const result = await runScheduledMonitor(process.env);
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

if (result.status !== "ok") process.exitCode = 1;
