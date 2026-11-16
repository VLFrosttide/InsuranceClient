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
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SAMPLE = path.join(__dirname, "IMG-20260508-WA0012.jpg");

// Scans are assumed upright, but the sample photo is stored sideways: the real
// engine check turns it once with plain Windows System.Drawing before reading.
function uprightSample() {
  const out = path.join(tmpDir(), "upright.png");
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$image = [System.Drawing.Image]::FromFile(${quote(SAMPLE)})`,
    "$image.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone)",
    `$image.Save(${quote(out)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$image.Dispose()",
  ].join("; ");
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
  });
  return out;
}

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
  const {
    ScanWatcher,
    ensureOcrLanguages,
    missingOcrLanguages,
    recognizeFile,
    layoutRows,
    fieldRows,
    pageText,
  } = await import(pathToFileURL(path.join(ROOT, "scans.js")).href);

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
        return [{ texts: [{ language: "tr-TR", text: "HELLO 123" }] }];
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

  await check("the OCR text is saved to OCRScans.txt and each scan overwrites it", async () => {
    const dir = tmpDir();
    const outFile = path.join(tmpDir(), "OCRScans.txt");
    const { watcher } = makeWatcher(dir, {
      outFile,
      recognize: async (file) =>
        path.basename(file) === "a.jpg"
          ? [
              { rotation: 0, score: 5, texts: [{ language: "tr-TR", text: "BİRİNCİ SAYFA" }] },
              { rotation: 0, score: 4, texts: [{ language: "tr-TR", text: "İKİNCİ SAYFA" }] },
            ]
          : [{ rotation: 0, score: 5, texts: [{ language: "tr-TR", text: "YENİ TARAMA" }] }],
    });
    watcher.start();
    fs.writeFileSync(path.join(dir, "a.jpg"), "a");
    await until(
      () => fs.existsSync(outFile) && fs.readFileSync(outFile, "utf8") === "BİRİNCİ SAYFA\n\nİKİNCİ SAYFA",
      4000,
      "the pages of the first scan in OCRScans.txt"
    );
    fs.writeFileSync(path.join(dir, "b.jpg"), "b");
    await until(
      () => fs.readFileSync(outFile, "utf8") === "YENİ TARAMA",
      4000,
      "the second scan to replace the text"
    );
    watcher.stop();
  });

  await check("without an explicit file the text lands next to the scans folder", async () => {
    const parent = tmpDir();
    const dir = path.join(parent, "Scans");
    const { watcher } = makeWatcher(dir);
    watcher.start();
    fs.writeFileSync(path.join(dir, "a.jpg"), "a");
    await until(
      () =>
        fs.existsSync(path.join(parent, "OCRScans.txt")) &&
        fs.readFileSync(path.join(parent, "OCRScans.txt"), "utf8") === "HELLO 123",
      4000,
      "OCRScans.txt next to the folder"
    );
    watcher.stop();
  });

  await check("a failed OCR leaves the saved text alone", async () => {
    const dir = tmpDir();
    const outFile = path.join(tmpDir(), "OCRScans.txt");
    fs.writeFileSync(outFile, "ESKİ METİN");
    const { watcher, log } = makeWatcher(dir, {
      outFile,
      recognize: async () => {
        throw new Error("engine broke");
      },
    });
    watcher.start();
    fs.writeFileSync(path.join(dir, "a.jpg"), "a");
    await until(() => log.lines.some((l) => l.includes("engine broke")), 4000, "the failed OCR");
    eq(fs.readFileSync(outFile, "utf8"), "ESKİ METİN", "the old text was replaced");
    watcher.stop();
  });

  await check("words on one printed row become one line with a box per cell", async () => {
    const lines = [
      {
        text: "(A) PLAKA",
        words: [
          { text: "(A)", x: 100, y: 200, width: 40, height: 30 },
          { text: "PLAKA", x: 150, y: 200, width: 80, height: 30 },
        ],
      },
      { text: "34PJY807", words: [{ text: "34PJY807", x: 400, y: 198, width: 140, height: 32 }] },
      {
        text: "(B) TESCİL",
        words: [
          { text: "(B)", x: 100, y: 260, width: 40, height: 30 },
          { text: "TESCİL", x: 150, y: 260, width: 80, height: 30 },
        ],
      },
      { text: "04/02/2026", words: [{ text: "04/02/2026", x: 400, y: 258, width: 140, height: 32 }] },
    ];
    eq(layoutRows(lines), [
      ["(A) PLAKA", "34PJY807"],
      ["(B) TESCİL", "04/02/2026"],
    ]);
  });

  await check("a tall word does not pull the row below it into its line", async () => {
    const lines = [
      {
        words: [
          { text: "A", x: 0, y: 0, width: 20, height: 20 },
          { text: "TALL", x: 200, y: 10, width: 60, height: 30 },
          { text: "B", x: 0, y: 30, width: 20, height: 20 },
        ],
      },
    ];
    eq(layoutRows(lines), [["A", "TALL"], ["B"]]);
  });

  await check("two printed lines are two rows", async () => {
    const lines = [
      {
        words: [
          { text: "ONE", x: 0, y: 0, width: 60, height: 20 },
          { text: "TWO", x: 0, y: 30, width: 60, height: 20 },
        ],
      },
    ];
    eq(layoutRows(lines), [["ONE"], ["TWO"]]);
  });

  // A form page: every field is a label - its printed code and name - with the
  // data in the box below it.
  const word = (text, x, y, width = 60, height = 20) => ({ text, x, y, width, height });

  await check("data goes to the label above it, not to the column it starts in", async () => {
    const lines = [
      {
        words: [
          word("(A)", 100, 0),
          word("PLAKA", 170, 0, 80),
          word("(B)", 400, 0),
          word("TESCİL", 470, 0, 80),
          // The data is centred in its box, so it does not start under the
          // label's left edge.
          word("34PJY807", 150, 40, 110),
          word("04/02/2026", 330, 40, 120),
        ],
      },
    ];
    eq(fieldRows(lines), [
      ["(A) PLAKA", "34PJY807"],
      ["(B) TESCİL", "04/02/2026"],
    ]);
  });

  await check("data printed beside its label on the same line stays with it", async () => {
    const lines = [
      {
        words: [word("(A)", 0, 0), word("PLAKA", 70, 0, 80), word("34PJY807", 300, 0, 110)],
      },
    ];
    eq(fieldRows(lines), [["(A) PLAKA", "34PJY807"]]);
  });

  await check("a code the reader mangled still starts a label", async () => {
    const lines = [
      { words: [word("(B)", 400, 0), word("TESCİL", 470, 0, 80)] },
      // "(C.1.2)" came back without its closing bracket, but it starts where the
      // labels of its column start.
      { words: [word("(C.ı.2jAD1", 400, 40, 100)] },
      { words: [word("DİLHAN", 410, 80, 80)] },
    ];
    eq(fieldRows(lines), [
      ["(B) TESCİL"],
      ["(C.ı.2jAD1", "DİLHAN"],
    ]);
  });

  await check("a page without printed codes keeps its printed rows", async () => {
    const lines = [{ words: [word("HELLO", 0, 0), word("123", 200, 0)] }];
    eq(fieldRows(lines), [["HELLO", "123"]]);
  });

  await check("printed text with no label above it keeps a line of its own", async () => {
    const lines = [
      { words: [word("T.C.", 0, 0, 40), word("KİMLİK", 50, 0, 60)] },
      { words: [word("(A)", 0, 40), word("PLAKA", 70, 40, 80)] },
      { words: [word("34PJY807", 20, 80, 110)] },
    ];
    eq(fieldRows(lines), [["T.C. KİMLİK"], ["(A) PLAKA", "34PJY807"]]);
  });

  await check("the saved text puts each box in its own tab column", async () => {
    const dir = tmpDir();
    const outFile = path.join(tmpDir(), "OCRScans.txt");
    const { watcher } = makeWatcher(dir, {
      outFile,
      recognize: async () => [
        {
          texts: [
            {
              language: "tr-TR",
              text: "(A) PLAKA 34PJY807",
              lines: [
                {
                  text: "(A) PLAKA",
                  words: [
                    { text: "(A)", x: 0, y: 0, width: 40, height: 30 },
                    { text: "PLAKA", x: 50, y: 0, width: 80, height: 30 },
                  ],
                },
                {
                  text: "34PJY807",
                  words: [{ text: "34PJY807", x: 300, y: 0, width: 140, height: 30 }],
                },
              ],
            },
          ],
        },
      ],
    });
    watcher.start();
    fs.writeFileSync(path.join(dir, "a.jpg"), "a");
    await until(
      () => fs.existsSync(outFile) && fs.readFileSync(outFile, "utf8").includes("\t"),
      4000,
      "the tab separated text"
    );
    eq(fs.readFileSync(outFile, "utf8"), "(A) PLAKA\t34PJY807");
    watcher.stop();
  });

  await check("a failed OCR is logged and the next scan is still read", async () => {
    const dir = tmpDir();
    const seen = [];
    const { watcher, log } = makeWatcher(dir, {
      recognize: async (file) => {
        seen.push(path.basename(file));
        if (seen.length === 1) throw new Error("engine broke");
        return [{ texts: [{ language: "tr-TR", text: "SECOND" }] }];
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
    eq(missingOcrLanguages(["bg", "en-US"]), ["tr"]);
    eq(missingOcrLanguages(["tr-TR"]), []);
    eq(missingOcrLanguages([]), ["tr"]);
  });

  await check("nothing is installed when Turkish is present", async () => {
    let installs = 0;
    const result = await ensureOcrLanguages({
      log: recorder(),
      list: async () => ["en-US", "tr-TR"],
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
        installed = [...installed, "tr-TR"];
        return true;
      },
    });
    eq(asked, [["tr-TR"]]);
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
    eq(result.missing, ["tr"]);
    ok(log.lines.some((l) => l.includes("still missing: tr-TR")), "not reported");
  });

  if (process.platform === "win32" && fs.existsSync(SAMPLE)) {
    await check("the real Windows OCR reads an upright scan", async () => {
      const pages = await recognizeFile(uprightSample());
      eq(pages.length, 1, "page count");
      const text = pages[0].texts.map((t) => t.text).join("\n");
      ok(text.includes("TOYOTA"), "the make was not read");
      // The row of the box holding the plate is rebuilt with label and value,
      // and no confidence column is left in the saved text.
      const saved = pageText(pages[0]);
      const plateRow = saved.split("\n").find((line) => line.includes("PLAKA"));
      ok(plateRow && plateRow.includes("34PJY807"), "the plate row was not rebuilt");
      ok(!saved.includes("%"), "a confidence was left in the text");
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
