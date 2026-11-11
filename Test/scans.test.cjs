"use strict";

// Node test for the Scans folder watcher + OCR (/scans.js).
//
// Runs the REAL module: the folder checks use a real temp folder and a real
// fs.watch listener. OCR is injected for the watcher checks, and one check
// runs the real Windows OCR engine on a sample document (Windows only).
//
// Run with:  node Test/scans.test.cjs   (or: npm test)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SAMPLE = path.join(__dirname, "IMG-20260508-WA0012.jpg");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  -> " + (err && err.stack ? err.stack : err));
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, timeoutMs = 4000, msg = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${msg}`);
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "scans-test-"));

// Collects everything the module logs.
function recorder() {
  const lines = [];
  const add = (...args) => lines.push(args.map(String).join(" "));
  return { lines, log: add, warn: add, error: add };
}

// Never let a stuck test hang `npm test`.
setTimeout(() => {
  console.error("scans tests timed out");
  process.exit(1);
}, 120000).unref();

(async () => {
  const { ScanWatcher, ensureOcrLanguages, missingOcrLanguages, recognizeFile } =
    await import(pathToFileURL(path.join(ROOT, "scans.js")).href);

  // A watcher whose OCR is a fake that records which files it was given.
  function makeWatcher(dir, opts = {}) {
    const calls = [];
    const log = recorder();
    const watcher = new ScanWatcher({
      dir,
      log,
      settleMs: 60,
      recognize: async (file) => {
        calls.push({ file, size: fs.statSync(file).size });
        return [{ rotation: 0, score: 9, texts: [{ language: "en-US", text: "HELLO 123" }] }];
      },
      ...opts,
    });
    return { watcher, calls, log };
  }

  await check("the folder is created when it does not exist", async () => {
    const dir = path.join(tmpDir(), "Scans");
    const { watcher } = makeWatcher(dir);
    eq(watcher.start(), true, "start() reports that it created the folder");
    ok(fs.statSync(dir).isDirectory(), "folder missing");
    watcher.stop();
  });

  await check("an existing folder is kept and its old files are not read", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "old.jpg"), "old scan");
    const { watcher, calls } = makeWatcher(dir);
    eq(watcher.start(), false, "start() reports that the folder existed");
    await sleep(300);
    eq(calls.length, 0, "old file was read");
    ok(fs.existsSync(path.join(dir, "old.jpg")), "old file was removed");
    watcher.stop();
  });

  await check("a new scan is read and its text is logged", async () => {
    const dir = tmpDir();
    const { watcher, calls, log } = makeWatcher(dir);
    watcher.start();
    fs.writeFileSync(path.join(dir, "scan1.jpg"), "new scan");
    await until(() => calls.length === 1, 4000, "OCR of the new scan");
    eq(calls[0].file, path.join(dir, "scan1.jpg"));
    await until(() => log.lines.some((l) => l.includes("HELLO 123")), 2000, "the log");
    ok(log.lines.some((l) => l.includes("scan1.jpg")), "file name not logged");
    ok(fs.existsSync(path.join(dir, "scan1.jpg")), "the scan must stay in the folder");
    await sleep(300);
    eq(calls.length, 1, "the same scan was read twice");
    watcher.stop();
  });

  await check("files that are not scans are ignored", async () => {
    const dir = tmpDir();
    const { watcher, calls } = makeWatcher(dir);
    watcher.start();
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a scan");
    fs.mkdirSync(path.join(dir, "folder.jpg"));
    await sleep(400);
    eq(calls.length, 0);
    watcher.stop();
  });

  await check("a scan still being written is read once, when complete", async () => {
    const dir = tmpDir();
    const { watcher, calls } = makeWatcher(dir, { settleMs: 200 });
    watcher.start();
    const fd = fs.openSync(path.join(dir, "slow.pdf"), "w");
    for (let i = 0; i < 12; i++) {
      fs.writeSync(fd, "x".repeat(1000));
      await sleep(40);
    }
    eq(calls.length, 0, "read before the scanner finished");
    fs.closeSync(fd);
    await until(() => calls.length === 1, 5000, "OCR of the finished scan");
    eq(calls[0].size, 12000, "read an incomplete file");
    await sleep(500);
    eq(calls.length, 1, "read more than once");
    watcher.stop();
  });

  await check("a scan replaced under the same name is read again", async () => {
    const dir = tmpDir();
    const { watcher, calls } = makeWatcher(dir);
    watcher.start();
    fs.writeFileSync(path.join(dir, "scan.png"), "first");
    await until(() => calls.length === 1, 4000, "first OCR");
    fs.writeFileSync(path.join(dir, "scan.png"), "second version");
    await until(() => calls.length === 2, 4000, "second OCR");
    watcher.stop();
  });

  await check("a failed OCR is logged and the next scan is still read", async () => {
    const dir = tmpDir();
    const seen = [];
    const { watcher, log } = makeWatcher(dir, {
      recognize: async (file) => {
        seen.push(path.basename(file));
        if (seen.length === 1) throw new Error("engine broke");
        return [{ rotation: 90, score: 1, texts: [{ language: "tr-TR", text: "SECOND" }] }];
      },
    });
    watcher.start();
    fs.writeFileSync(path.join(dir, "a.jpg"), "a");
    await until(() => seen.length === 1, 4000, "first OCR");
    fs.writeFileSync(path.join(dir, "b.jpg"), "b");
    await until(() => log.lines.some((l) => l.includes("SECOND")), 4000, "second OCR");
    ok(log.lines.some((l) => l.includes("engine broke")), "failure not logged");
    watcher.stop();
  });

  await check("missing languages are worked out from the installed packs", async () => {
    eq(missingOcrLanguages(["bg", "en-US"]), ["tr", "ar"]);
    eq(missingOcrLanguages(["en-GB", "tr-TR", "ar-SA"]), []);
    eq(missingOcrLanguages([]), ["en", "tr", "ar"]);
  });

  await check("nothing is installed when all three languages are present", async () => {
    let installs = 0;
    const result = await ensureOcrLanguages({
      log: recorder(),
      list: async () => ["en-US", "tr-TR", "ar-SA"],
      install: async () => installs++,
    });
    eq(installs, 0);
    eq(result.missing, []);
  });

  await check("missing packs are installed and then checked again", async () => {
    let installed = ["bg", "en-US"];
    const asked = [];
    const result = await ensureOcrLanguages({
      log: recorder(),
      list: async () => installed,
      install: async (tags) => {
        asked.push(tags);
        installed = [...installed, "tr-TR", "ar-SA"];
        return true;
      },
    });
    eq(asked, [["tr-TR", "ar-SA"]]);
    eq(result.missing, []);
  });

  await check("a refused install is reported, not thrown", async () => {
    const log = recorder();
    const result = await ensureOcrLanguages({
      log,
      list: async () => ["en-US"],
      install: async () => {
        throw new Error("The operation was canceled by the user.");
      },
    });
    eq(result.missing, ["tr", "ar"]);
    ok(log.lines.some((l) => l.includes("still missing: tr-TR, ar-SA")), "not reported");
  });

  if (process.platform === "win32" && fs.existsSync(SAMPLE)) {
    await check("the real Windows OCR reads a sideways sample document", async () => {
      const pages = await recognizeFile(SAMPLE);
      eq(pages.length, 1, "page count");
      eq(pages[0].rotation, 270, "rotation that reads best");
      const text = pages[0].texts.map((t) => t.text).join("\n");
      ok(text.includes("TOYOTA"), "the make was not read");
    });
  } else {
    console.log("  SKIP  the real Windows OCR check (needs Windows and the sample image)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
