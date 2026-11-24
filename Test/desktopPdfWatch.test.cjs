"use strict";

// Node test for the Desktop PDF eligibility rules (/desktopPdfWatch.js): which
// PDFs on the Desktop belong to the form that is open right now.
//
// The rule under test is the one that decides whether a file may be uploaded,
// printed and deleted. Getting it wrong in either direction hurts: too strict
// leaves freshly downloaded PDFs on the Desktop (the walk-in leak), too loose
// prints and deletes a worker's unrelated files.
//
// Run with:  node Test/desktopPdfWatch.test.cjs   (or: npm test)

const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.stack ? err.stack : err));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || "values differ"}: expected ${e}, got ${a}`);
}

(async () => {
  const rules = await import(pathToFileURL(path.join(ROOT, "desktopPdfWatch.js")).href);
  const {
    desktopPdfAlreadyHandled,
    desktopPdfBelongsToForm,
    desktopPdfCreatedMs,
    desktopPdfIdentity,
    desktopPdfPrintOrder,
  } = rules;

  const CLICK = 1_700_000_000_000; // the moment the form was opened
  const stat = ({ size, birthtimeMs, mtimeMs = 0 }) => ({ size, birthtimeMs, mtimeMs });
  // A watch started at CLICK with `files` already on the Desktop.
  const watch = (files = [], sinceMs = CLICK) => ({
    sinceMs,
    existing: new Map(files),
  });

  // --- identity -------------------------------------------------------------

  check("the creation time is the birth time when the filesystem reports one", () => {
    eq(desktopPdfCreatedMs(stat({ size: 1, birthtimeMs: CLICK, mtimeMs: 5 })), CLICK, "birth time");
  });

  check("without a birth time the modification time is used", () => {
    eq(desktopPdfCreatedMs(stat({ size: 1, birthtimeMs: 0, mtimeMs: 42 })), 42, "mtime");
    eq(desktopPdfCreatedMs(stat({ size: 1, birthtimeMs: Number.NaN, mtimeMs: 7 })), 7, "NaN");
    eq(desktopPdfCreatedMs(null), 0, "no stat");
  });

  check("identity is the size together with the creation time", () => {
    eq(
      desktopPdfIdentity(stat({ size: 900, birthtimeMs: CLICK })),
      { size: 900, createdMs: CLICK },
      "both"
    );
  });

  // --- files that are already on the Desktop --------------------------------

  check("a PDF downloaded after the form was opened is handled", () => {
    const w = watch();
    eq(
      desktopPdfBelongsToForm(w, "C:/Desktop/new.pdf", { size: 10, createdMs: CLICK + 5 }),
      true,
      "new file"
    );
  });

  check("an old PDF that was already there is never touched", () => {
    const old = { size: 10, createdMs: CLICK - 60_000 };
    const w = watch([["C:/Desktop/old.pdf", old]]);
    eq(desktopPdfBelongsToForm(w, "C:/Desktop/old.pdf", old), false, "unchanged old file");
  });

  check("a leftover from an earlier walk-in is never touched", () => {
    const left = { size: 480_114, createdMs: CLICK - 3_600_000 };
    const w = watch([["C:/Desktop/8a15af00.pdf", left]]);
    eq(desktopPdfBelongsToForm(w, "C:/Desktop/8a15af00.pdf", left), false, "yesterday's leftover");
  });

  check("a PDF downloaded between the click and the form loading is handled", () => {
    // It is already on the Desktop when the watch starts, but created after the
    // click: this is the one case the snapshot alone cannot see.
    const gap = { size: 754_613, createdMs: CLICK + 800 };
    const w = watch([["C:/Desktop/BG_02_ FI26192158.pdf", gap]]);
    eq(
      desktopPdfBelongsToForm(w, "C:/Desktop/BG_02_ FI26192158.pdf", gap),
      true,
      "gap download"
    );
  });

  check("an old file whose timestamps were touched is still left alone", () => {
    // A copy, a scan or a sync can move the modification time, but the creation
    // time stays before the click, so the click time is the lower bound.
    const old = { size: 10, createdMs: CLICK - 120_000 };
    const w = watch([["C:/Desktop/old.pdf", old]]);
    eq(desktopPdfBelongsToForm(w, "C:/Desktop/old.pdf", old), false, "old creation time");
  });

  check("an old PDF re-downloaded under the same name is handled", () => {
    // Windows keeps the original creation time when a file is overwritten, so
    // the size is what gives the new download away.
    const before = { size: 10, createdMs: CLICK - 120_000 };
    const after = { size: 20, createdMs: CLICK - 120_000 };
    const w = watch([["C:/Desktop/BG_02_ FI1.pdf", before]]);
    eq(desktopPdfBelongsToForm(w, "C:/Desktop/BG_02_ FI1.pdf", after), true, "size changed");
  });

  check("a file created exactly at the click counts (the boundary is inclusive)", () => {
    const same = { size: 10, createdMs: CLICK };
    const w = watch([["C:/Desktop/same.pdf", same]]);
    eq(desktopPdfBelongsToForm(w, "C:/Desktop/same.pdf", same), true, "same millisecond");
  });

  check("a missing watch or identity never claims a file", () => {
    eq(desktopPdfBelongsToForm(null, "x.pdf", { size: 1, createdMs: CLICK }), false, "no watch");
    eq(desktopPdfBelongsToForm(watch(), "x.pdf", null), false, "no identity");
  });

  // --- files already handled in this watch ---------------------------------

  check("the same file is not handled twice", () => {
    eq(
      desktopPdfAlreadyHandled({ size: 10, createdMs: CLICK }, { size: 10, createdMs: CLICK }),
      true,
      "same file"
    );
  });

  check("the same name written again is handled again", () => {
    const id = { size: 10, createdMs: CLICK };
    eq(desktopPdfAlreadyHandled(id, { size: 11, createdMs: CLICK }), false, "size changed");
    eq(desktopPdfAlreadyHandled(id, { size: 10, createdMs: CLICK + 1 }), false, "time changed");
  });

  check("a file that was never handled is not reported as handled", () => {
    eq(desktopPdfAlreadyHandled(undefined, { size: 1, createdMs: CLICK }), false, "never seen");
    eq(desktopPdfAlreadyHandled({ size: 1, createdMs: CLICK }, null), false, "no identity");
  });

  // --- print order ----------------------------------------------------------

  // The policy ("BG_02_ FI<policy>.pdf") always prints before the invoice /
  // payment slip, however the two downloads reached the Desktop.
  const invoice = { filename: "8a15af00-4c7b-4e2a-9f11.pdf" };
  const policy = { filename: "BG_02_ FI26192158.pdf" };

  check("the policy prints before the invoice when the invoice arrived first", () => {
    eq(desktopPdfPrintOrder([invoice, policy]), [policy, invoice], "invoice first");
  });

  check("the policy prints before the invoice when it already arrived first", () => {
    eq(desktopPdfPrintOrder([policy, invoice]), [policy, invoice], "policy first");
  });

  check("the policy name is recognised with and without the space", () => {
    const tight = { filename: "BG_02_FI26192159.pdf" };
    eq(desktopPdfPrintOrder([invoice, policy, tight]), [policy, tight, invoice], "both shapes");
  });

  check("documents that are not policies keep their order after the policy", () => {
    const a = { filename: "a.pdf" };
    const b = { filename: "b.pdf" };
    eq(desktopPdfPrintOrder([a, policy, b]), [policy, a, b], "stable order");
  });

  check("an empty print set has no policy to move", () => {
    eq(desktopPdfPrintOrder([]), [], "empty");
    eq(desktopPdfPrintOrder(null), [], "none");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

