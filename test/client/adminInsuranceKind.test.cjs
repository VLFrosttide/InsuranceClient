"use strict";

// Node test for the admin add-insurance form's "Kind" dropdown (border
// insurance / medical insurance / civil liability).
//
// The list of kinds is owned by the server (Requests/InsuranceKinds.js, served
// by GET /insurance-kinds). This test cuts the REAL kind block out of
// renderer/AdminInsurance/AdminInsurance.js and runs it in a vm with a fake
// select, `t`, `getLang` and `api`, then checks that:
//   - the fallback list paints at once and selects border,
//   - GET /insurance-kinds replaces it, hides `allowed: false` kinds and honours
//     `defaultKind`,
//   - a chosen kind survives a reload and a language switch,
//   - an unreachable server keeps the fallback list,
//   - the form sends the chosen kind and resets to the default on Clear.
//
// Run with:  node test/client/adminInsuranceKind.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const ADMIN_JS = path.join(ROOT, "renderer", "AdminInsurance", "AdminInsurance.js");
const ADMIN_HTML = path.join(
  ROOT,
  "renderer",
  "AdminInsurance",
  "AdminInsurance.html"
);
const COMMON_JS = path.join(ROOT, "renderer", "common.js");

const START_MARKER = 'const DEFAULT_INSURANCE_KIND = "border";';
const END_MARKER = "// Payment options / currency / broker-mode visibility";

const src = fs.readFileSync(ADMIN_JS, "utf8");
const start = src.indexOf(START_MARKER);
const end = start < 0 ? -1 : src.indexOf(END_MARKER, start);
if (start < 0 || end < 0) {
  console.error("Could not locate the kind block in AdminInsurance.js (moved?)");
  process.exit(1);
}
const block = src.slice(start, end);

// --- fakes -------------------------------------------------------------------
function fakeSelect() {
  return {
    value: "",
    children: [],
    replaceChildren() {
      this.children = [];
      this.value = "";
    },
    appendChild(option) {
      this.children.push(option);
    },
    values() {
      return this.children.map((option) => String(option.value));
    },
    labels() {
      return this.children.map((option) => String(option.textContent));
    },
  };
}

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

// The server's answer, shaped like GET /insurance-kinds builds it.
function serverKinds(overrides) {
  return Object.assign(
    {
      kinds: [
        {
          value: "border",
          label: "Border insurance",
          labelBg: "Гранична застраховка",
          adminOnly: false,
          allowed: true,
        },
        {
          value: "medical",
          label: "Medical insurance",
          labelBg: "Медицинска застраховка",
          adminOnly: true,
          allowed: true,
        },
        {
          value: "civil",
          label: "Civil liability",
          labelBg: "Гражданска отговорност",
          adminOnly: true,
          allowed: true,
        },
      ],
      defaultKind: "border",
    },
    overrides || {}
  );
}
// Builds a context with the kind block loaded in it.
function setup({ answer, lang = "bg" } = {}) {
  const state = { lang, calls: [], picks: [] };
  const select = fakeSelect();
  const CTX = {
    console: { warn: () => {}, log: () => {}, error: () => {} },
    KindInput: select,
    document: { createElement: () => ({}) },
    getLang: () => state.lang,
    t: (key, fallback) => {
      const dict = KIND_LABELS[state.lang] || KIND_LABELS.bg;
      if (dict[key] !== undefined) return dict[key];
      if (KIND_LABELS.en[key] !== undefined) return KIND_LABELS.en[key];
      return fallback !== undefined ? fallback : key;
    },
    api: async (url) => {
      state.calls.push(url);
      state.picks.push(select.value);
      const reply = typeof answer === "function" ? answer(url) : answer;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  vm.createContext(CTX);
  vm.runInContext(
    block +
      "\n;globalThis.__render = () => renderInsuranceKinds();" +
      "\nglobalThis.__load = () => loadInsuranceKinds();" +
      "\nglobalThis.__kinds = () => allowedInsuranceKinds();" +
      "\nglobalThis.__default = () => defaultInsuranceKind;",
    CTX,
    { filename: "AdminInsurance.js#kinds" }
  );
  return { CTX, select, state };
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
const HTML = fs.readFileSync(ADMIN_HTML, "utf8");
const JS = fs.readFileSync(ADMIN_JS, "utf8");
const COMMON = fs.readFileSync(COMMON_JS, "utf8");
(async () => {
  console.log("Admin add-insurance form — kinds of insurance");

  await check("the form has a Kind select labelled in both languages", () => {
    ok(
      /<label for="KindInput" data-i18n="add\.kind">/.test(HTML),
      "the label points at KindInput"
    );
    ok(
      flat(HTML).includes('<select id="KindInput" class="FormInput"></select>'),
      "the select is a FormInput so it travels with the form"
    );
    ok(/"add\.kind": "Insurance kind"/.test(COMMON), "English label");
    ok(/"add\.kind": "Вид застраховка"/.test(COMMON), "Bulgarian label");
  });

  await check("border, medical and civil are translated in both languages", () => {
    for (const [key, en, bg] of [
      ["kind.border", "Border insurance", "Гранична застраховка"],
      ["kind.medical", "Medical insurance", "Медицинска застраховка"],
      ["kind.civil", "Civil liability", "Гражданска отговорност"],
    ]) {
      ok(
        new RegExp(`"${key.replace(".", "\\.")}": "${en}"`).test(COMMON),
        key + " (en)"
      );
      ok(
        new RegExp(`"${key.replace(".", "\\.")}": "${bg}"`).test(COMMON),
        key + " (bg)"
      );
    }
  });

  await check("the fallback list paints at once and selects border", () => {
    const { CTX, select } = setup({});
    CTX.__render();
    eq(select.values(), ["border", "medical", "civil"], "offered kinds");
    eq(select.value, "border", "default choice");
    eq(
      select.labels(),
      [
        "Гранична застраховка",
        "Медицинска застраховка",
        "Гражданска отговорност",
      ],
      "labels follow the language on screen"
    );
    eq(CTX.__default(), "border", "default kind");
  });

  await check("GET /insurance-kinds replaces the list and is honoured", async () => {
    const { CTX, select, state } = setup({ answer: serverKinds() });
    CTX.__render();
    await CTX.__load();
    eq(state.calls, ["/insurance-kinds"], "one request");
    eq(select.values(), ["border", "medical", "civil"], "server order kept");
    eq(select.value, "border", "server default chosen");
    eq(CTX.__default(), "border", "default kind from the server");
  });

  await check("a kind the caller may not create is not offered", async () => {
    const answer = serverKinds();
    answer.kinds[1].allowed = false; // medical
    const { CTX, select } = setup({ answer });
    await CTX.__load();
    eq(select.values(), ["border", "civil"], "medical is hidden");
    eq(CTX.__kinds().map((k) => k.value), ["border", "civil"], "allowed kinds");
  });

  await check("the server may name another default kind", async () => {
    const { CTX, select } = setup({
      answer: serverKinds({ defaultKind: "medical" }),
    });
    await CTX.__load();
    eq(select.value, "medical", "the server's default is selected");
  });

  await check("a kind chosen by the admin survives a reload", async () => {
    const { CTX, select } = setup({ answer: serverKinds() });
    await CTX.__load();
    select.value = "civil";
    await CTX.__load();
    eq(select.value, "civil", "still civil after the reload");
  });

  await check("switching the language keeps the choice and re-labels", async () => {
    const { CTX, select, state } = setup({ answer: serverKinds(), lang: "bg" });
    await CTX.__load();
    select.value = "medical";
    state.lang = "en";
    CTX.__render();
    eq(select.value, "medical", "the choice is kept");
    eq(
      select.labels(),
      ["Border insurance", "Medical insurance", "Civil liability"],
      "labels are English now"
    );
  });

  await check("a kind the client does not translate uses the server's label", async () => {
    const answer = serverKinds();
    answer.kinds.push({
      value: "travel",
      label: "Travel insurance",
      labelBg: "Туристическа застраховка",
      adminOnly: false,
      allowed: true,
    });
    const { CTX, select } = setup({ answer, lang: "bg" });
    await CTX.__load();
    eq(select.values(), ["border", "medical", "civil", "travel"], "the new kind");
    eq(select.labels()[3], "Туристическа застраховка", "Bulgarian server label");
  });

  await check("an unreachable server keeps the fallback list", async () => {
    const { CTX, select } = setup({ answer: new Error("offline") });
    await CTX.__load();
    eq(select.values(), ["border", "medical", "civil"], "fallback kinds");
    eq(select.value, "border", "default choice");
  });
  await check("the form saves the chosen kind (never the label)", () => {
    ok(
      flat(JS).includes(
        "Kind: String( FormObject.KindInput || defaultInsuranceKind || DEFAULT_INSURANCE_KIND ).trim(),"
      ),
      "the payload carries the selected value"
    );
    ok(
      /option\.value = String\(kind\.value\);/.test(JS),
      "option value is the stored value"
    );
    ok(
      /option\.textContent = insuranceKindLabel\(kind\);/.test(JS),
      "option text is the label"
    );
  });

  await check("Clear and the language button keep the select honest", () => {
    ok(
      /if \(KindInput\) KindInput\.value = defaultInsuranceKind;/.test(JS),
      "Clear returns to the default kind"
    );
    ok(
      /LangButton\.addEventListener\("click", \(\) => \{[\s\S]*?renderInsuranceKinds\(\);/.test(
        JS
      ),
      "the language button rebuilds the labels"
    );
    ok(
      /renderInsuranceKinds\(\);\s*[\s\S]{0,300}?loadInsuranceKinds\(\)/.test(JS),
      "the page paints the fallback kinds and then loads the server's list"
    );
  });

  await check("the new admin-only-kind errors are translated", () => {
    for (const message of [
      "Only admins can create medical insurance",
      "Only admins can create civil liability",
      "Only admins can edit medical insurance",
      "Only admins can edit civil liability",
      "Only admins can annul medical insurance",
      "Only admins can annul civil liability",
    ]) {
      ok(
        flat(COMMON).includes(`"${message}": "err.adminOnlyKind`),
        "mapped: " + message
      );
    }
    ok(
      /"err\.adminOnlyKindCreate":/.test(COMMON) &&
        /"err\.adminOnlyKindEdit":/.test(COMMON) &&
        /"err\.adminOnlyKindAnnul":/.test(COMMON),
      "the keys exist"
    );
    ok(
      /"err\.adminOnlyKindCreate": "Only admins can create this kind of insurance"/.test(
        COMMON
      ),
      "English text"
    );
    ok(
      /"err\.adminOnlyKindCreate":\s*"Само администратори могат да създават този вид застраховка"/.test(
        COMMON
      ),
      "Bulgarian text"
    );
  });

  if (failed) {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, 0 failed`);
})();
