"use strict";

// Node test for the policy kind (border / medical / civil) in the dashboard:
// its labels, the edit dropdown, the tariff rule and the list/export/filter
// wiring in renderer/WorkPage/WorkPage.js.
//
// The REAL kind block is cut out of WorkPage.js and run in a vm with fake `t`,
// `getLang` and `api`, so the helpers are checked against the shipping code.
//
// Run with:  node test/client/insuranceKindUi.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const START_MARKER = 'const BORDER_KIND = "border";';
const END_MARKER = "// Duration dropdown options (values in days)";

const src = fs.readFileSync(WORKPAGE, "utf8");
const start = src.indexOf(START_MARKER);
const end = start < 0 ? -1 : src.indexOf(END_MARKER, start);
if (start < 0 || end < 0) {
  console.error("Could not locate the kind block in WorkPage.js (moved?)");
  process.exit(1);
}
const block = src.slice(start, end);

const KIND_LABELS = {
  en: {
    "kind.border": "Border insurance",
    "kind.medical": "Medical insurance",
    "kind.civil": "Civil liability",
  },
  bg: {
    "kind.border": "Гранична застраховка",
    "kind.medical": "Медицинска застраховка",
    "kind.civil": "Гражданска отговорност",
  },
};

function serverKinds(overrides) {
  return Object.assign(
    {
      kinds: [
        {
          value: "border",
          label: "Border insurance",
          labelBg: "Гранична застраховка",
          allowed: true,
        },
        {
          value: "medical",
          label: "Medical insurance",
          labelBg: "Медицинска застраховка",
          allowed: true,
        },
        {
          value: "civil",
          label: "Civil liability",
          labelBg: "Гражданска отговорност",
          allowed: true,
        },
      ],
    },
    overrides || {}
  );
}

function setup({ answer, lang = "bg" } = {}) {
  const state = { lang, calls: 0 };
  const CTX = {
    console: { warn: () => {}, log: () => {}, error: () => {} },
    getLang: () => state.lang,
    t: (key, fallback) => {
      const dict = KIND_LABELS[state.lang] || KIND_LABELS.bg;
      if (dict[key] !== undefined) return dict[key];
      if (KIND_LABELS.en[key] !== undefined) return KIND_LABELS.en[key];
      return fallback !== undefined ? fallback : key;
    },
    api: async () => {
      state.calls++;
      const reply = typeof answer === "function" ? answer() : answer;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  vm.createContext(CTX);
  vm.runInContext(
    block +
      "\n;globalThis.__kindOf = (i) => policyKindOf(i);" +
      "\nglobalThis.__label = (v) => policyKindLabel(v);" +
      "\nglobalThis.__tariffs = (v) => kindUsesTariffs(v);" +
      "\nglobalThis.__options = (v) => editKindOptions(v);" +
      "\nglobalThis.__load = () => loadInsuranceKinds();" +
      "\nglobalThis.__kinds = () => insuranceKinds;",
    CTX,
    { filename: "WorkPage.js#kinds" }
  );
  return { CTX, state };
}

// --- tiny assert helpers -----------------------------------------------------
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  -> " + err.message);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b)
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
const flat = (text) => String(text).replace(/\s+/g, " ");
(async () => {
  console.log("Policy kind in the dashboard (border / medical / civil)");

  await check("a row without a kind is border insurance", () => {
    const { CTX } = setup();
    eq(CTX.__kindOf({}), "border", "missing");
    eq(CTX.__kindOf({ Kind: "" }), "border", "empty");
    eq(CTX.__kindOf({ Kind: " MEDICAL " }), "medical", "trimmed and lowercased");
    eq(CTX.__kindOf(null), "border", "no row");
  });

  await check("labels follow the language and the server list", async () => {
    const { CTX, state } = setup({ answer: serverKinds(), lang: "bg" });
    await CTX.__load();
    eq(CTX.__label("border"), "Гранична застраховка", "bg border");
    eq(CTX.__label("medical"), "Медицинска застраховка", "bg medical");
    eq(CTX.__label("civil"), "Гражданска отговорност", "bg civil");
    state.lang = "en";
    eq(CTX.__label("civil"), "Civil liability", "en civil");
    // A kind added on the server after this client was built uses the server's
    // label instead of showing a raw value.
    const answer = serverKinds();
    answer.kinds.push({
      value: "travel",
      label: "Travel insurance",
      labelBg: "Туристическа застраховка",
      allowed: true,
    });
    const next = setup({ answer, lang: "bg" });
    await next.CTX.__load();
    eq(next.CTX.__label("travel"), "Туристическа застраховка", "server label");
  });

  await check("an unknown kind with no server entry shows its stored value", () => {
    const { CTX } = setup();
    eq(CTX.__label("legacy"), "legacy", "raw value");
  });

  await check("only border insurance is priced from the tariffs", () => {
    const { CTX } = setup();
    eq(CTX.__tariffs("border"), true, "border");
    eq(CTX.__tariffs(""), true, "a row without a kind is border");
    eq(CTX.__tariffs(undefined), true, "undefined is border");
    eq(CTX.__tariffs("medical"), false, "medical is hand-priced");
    eq(CTX.__tariffs("civil"), false, "civil is hand-priced");
  });

  await check("the edit dropdown offers the allowed kinds and keeps the stored one", async () => {
    const answer = serverKinds();
    answer.kinds[2].allowed = false; // civil
    const { CTX } = setup({ answer });
    await CTX.__load();
    eq(
      CTX.__options("border").map((o) => o.value),
      ["border", "medical"],
      "a kind the caller may not use is hidden"
    );
    eq(
      CTX.__options("civil").map((o) => o.value),
      ["border", "medical", "civil"],
      "the stored kind stays selectable"
    );
    eq(CTX.__options("border")[0].label, "Гранична застраховка", "translated label");
  });

  await check("the server list replaces the fallback; a failure keeps it", async () => {
    const answer = serverKinds({ kinds: [{ value: "border", allowed: true }] });
    const { CTX, state } = setup({ answer });
    await CTX.__load();
    eq(CTX.__kinds().map((k) => k.value), ["border"], "server list");
    await CTX.__load();
    eq(state.calls, 2, "each call asks again once the previous finished");

    const offline = setup({ answer: new Error("offline") });
    await offline.CTX.__load();
    eq(
      offline.CTX.__kinds().map((k) => k.value),
      ["border", "medical", "civil"],
      "fallback list"
    );
  });

  await check("the lookup table shows the kind and can sort by it", () => {
    ok(
      flat(src).includes('key: "Kind", label: t("add.kind")'),
      "the Kind column exists"
    );
    ok(
      /format: \(_v, item\) => policyKindLabel\(policyKindOf\(item\)\),\s*\.\.\.sortHeader\("Kind"\),/.test(
        src
      ),
      "its cells are labelled and the header sorts"
    );
  });

  await check("the Excel export carries the kind, next to the car number", () => {
    ok(
      /{ label: t\("carNumber"\), width: 14 },\s*{ label: t\("add\.kind"\), width: 22 },/.test(
        src
      ),
      "export column after the car number"
    );
    ok(
      /text\(r\.CarNumber\),\s*policyKindLabel\(policyKindOf\(r\)\),/.test(src),
      "export cell value matches the table"
    );
  });

  await check("the lookup can filter on the kind", () => {
    ok(
      /if \(kind\) params\.set\("kind", kind\);/.test(src),
      "?kind= is sent"
    );
    ok(
      !!/!kind &&\s*!annulled/.test(src),
      "the kind alone is a valid search"
    );
    ok(
      /kindInput\.addEventListener\("change", rememberSearch\);/.test(src),
      "the filter is remembered with the tab"
    );
  });

  await check("the edit dialog lets an admin change the kind only", () => {
    ok(
      flat(src).includes('key: "Kind", label: t("add.kind"), type: "select"'),
      "the field exists"
    );
    ok(
      flat(src).includes("disabled: userRole !== \"1\","),
      "workers cannot change it"
    );
  });

  await check("the edit dialog never re-prices a hand-priced policy", () => {
    ok(
      /if \(!usesTariffs\(\)\) return;/.test(src),
      "the tariff recalculation is skipped"
    );
    ok(
      /kindInput \? kindUsesTariffs\(kindInput\.value\) : kindUsesTariffs\(insurance\.Kind\)/.test(
        flat(src)
      ),
      "the current kind (or the stored one) decides"
    );
    ok(
      /if \(!isEmailPolicy && kindUsesTariffs\(insurance\.Kind\)\) \{/.test(src),
      "the non-Turk / card-fee toggles are border-only"
    );
  });

  await check("the edit dialog only demands the border numbers for border", () => {
    ok(
      /const editedKind = "Kind" in payload \? payload\.Kind : insurance\.Kind;/.test(
        src
      ),
      "the kind being saved decides"
    );
    ok(
      /const needsPolicyDetails = kindUsesTariffs\(editedKind\);/.test(src),
      "border keeps the numbers required"
    );
    ok(
      /if \(!payload\.BlancNumber\) \{\s*if \(needsPolicyDetails\) throw new Error\(t\("add\.blancNumberRequired"\)\);\s*delete payload\.BlancNumber;/.test(
        src
      ),
      "a blank blanc keeps the stored key on a hand-priced policy"
    );
    ok(
      /if \(!payload\.CarNumber && needsPolicyDetails\) \{\s*throw new Error\(t\("add\.carNumberRequired"\)\);/.test(
        src
      ),
      "a blank car number is allowed off the border product"
    );
    ok(
      /if \(!payload\.PolicyNumber && !needsPolicyDetails\) \{\s*delete payload\.PolicyNumber;/.test(
        src
      ),
      "a blank policy number keeps its reference on a hand-priced policy"
    );
  });

  if (failed) {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, 0 failed`);
})();
