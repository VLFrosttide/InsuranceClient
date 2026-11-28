"use strict";

// Runs the Node test suite, one file at a time, and stops at the first failure.
//
//   node test/run-all.cjs              every test (test/client, then test/server)
//   node test/run-all.cjs broker       only paths containing "broker"
//   node test/run-all.cjs server       only test/server
//
// The tests use no framework: each file prints PASS/FAIL lines and exits
// non-zero on failure, which is all this runner needs.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const GROUP_DIRS = ["client", "server"];

function collect(group) {
  const dir = path.join(__dirname, group);
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".test.cjs"))
    .sort()
    .map((file) => path.join(dir, file));
}

const filters = process.argv.slice(2);
const files = GROUP_DIRS.flatMap(collect).filter((file) => {
  if (filters.length === 0) return true;
  const relative = path.relative(__dirname, file).replace(/\\/g, "/");
  return filters.some((needle) => relative.includes(needle));
});

if (files.length === 0) {
  console.error("No tests matched: " + (filters.join(" ") || "(all)"));
  process.exit(1);
}

let passed = 0;
for (const file of files) {
  const relative = path.relative(process.cwd(), file).replace(/\\/g, "/");
  console.log("\n=== " + relative + " ===");

  const result = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("\nFAILED: " + relative);
    process.exit(result.status || 1);
  }
  passed++;
}

console.log("\n" + passed + " test files passed");
