import assert from "node:assert/strict";
import test from "node:test";

import { retainProjectFilter } from "../assets/filter-state.js";

test("keeps the selected project when it exists in the next month", () => {
  assert.deepEqual(retainProjectFilter(["案件A", "案件B"], "案件B"), {
    projects: ["案件A", "案件B"],
    selectedProject: "案件B",
  });
});

test("keeps the selected project with zero results when it is absent from the next month", () => {
  assert.deepEqual(retainProjectFilter(["案件A"], "案件B"), {
    projects: ["案件A", "案件B"],
    selectedProject: "案件B",
  });
});

test("defaults an empty selection to all projects", () => {
  assert.deepEqual(retainProjectFilter(["案件A"], ""), {
    projects: ["案件A"],
    selectedProject: "all",
  });
});
