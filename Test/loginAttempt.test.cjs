"use strict";

// Node test for the login-attempt feedback on the login page
// (renderer/LoginPage/logic.js). A login can take a while (up to three 15 s
// server attempts), so the worker has to be able to tell two things at a glance:
//   * an attempt is still running -- the form is frozen, the button carries a
//     spinner and the phase line under it says what is happening, escalating to
//     "Waiting for the server… (N s)" when the server stays silent;
//   * the attempt has finished -- green + "Login successful — loading…" while the
//     work page opens, or the form usable again with a red card and the error.
//
// Runs the REAL renderer files (common.js for the strings, netMonitor.js and
// logic.js) in a vm, against a stub DOM built from the real index.html, a stub
// fetch and a fake clock -- the same vm approach as the other renderer tests.
//
// Run with:  node Test/loginAttempt.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const RENDERER = path.join(ROOT, "renderer");
const LOGIN_HTML = path.join(RENDERER, "LoginPage", "index.html");

const html = fs.readFileSync(LOGIN_HTML, "utf8");

// --- tiny assert helpers -----------------------------------------------------
// Written with fs.writeSync so a run that dies early still leaves its output
// behind: the fake clock keeps no real timers alive, so a hung await can end
// Node before buffered console output would ever be flushed.
function log(line) {
  fs.writeSync(1, line + "\n");
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      log("  PASS  " + name);
    } catch (err) {
      failed++;
      log("  FAIL  " + name);
      log("        " + (err && err.message ? err.message : err));
    }
  })();
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function ok(value, label) {
  if (!value) throw new Error(label || "expected a truthy value");
}

// Let pending promise callbacks run (the fake clock only drives timers).
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}
async function settleDeep() {
  for (let i = 0; i < 12; i++) await settle();
}

// --- stub DOM ----------------------------------------------------------------
// One element model is enough for the login page: text, classes, attributes,
// disabled state and the listeners logic.js attaches.
function makeEl(tagName, id) {
  const classes = new Set();
  const attrs = new Map();
  const listeners = new Map();
  const el = {
    tagName: String(tagName || "div").toUpperCase(),
    id: id || "",
    textContent: "",
    value: "",
    type: "text",
    title: "",
    placeholder: "",
    disabled: false,
    children: [],
    options: [],
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    dispatch(type) {
      const fn = listeners.get(type);
      if (fn) fn({ preventDefault() {} });
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    focus() {},
    select() {},
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    },
    get innerHTML() {
      return "";
    },
    set innerHTML(value) {
      if (!value) el.children.length = 0;
    },
  };
  return el;
}

// Builds the element registry from the real index.html, so a missing or renamed
// id in the page (e.g. #LoginProgress) shows up as a test failure instead of
// being papered over by the stub.
function makeDocument(source) {
  const elements = new Map();
  const tagRe = /<([a-zA-Z0-9]+)\b([^>]*)>/g;
  let tag;
  while ((tag = tagRe.exec(source))) {
    const attrs = tag[2];
    const idMatch = /\bid="([^"]+)"/.exec(attrs);
    if (!idMatch) continue;
    const el = makeEl(tag[1], idMatch[1]);
    // `type` is a property on the stub (an input's masked/readable state), the
    // data-i18n* markers drive translatePage.
    const attrRe = /\b(data-i18n(?:-title|-placeholder)?|type)="([^"]*)"/g;
    let attr;
    while ((attr = attrRe.exec(attrs))) {
      if (attr[1] === "type") el.type = attr[2];
      else el.setAttribute(attr[1], attr[2]);
    }
    const classMatch = /\bclass="([^"]*)"/.exec(attrs);
    if (classMatch) el.className = classMatch[1];
    elements.set(idMatch[1], el);
  }

  const body = makeEl("body", "body");
  const document = {
    documentElement: { lang: "" },
    body,
    visibilityState: "visible",
    readyState: "complete",
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tagName) {
      return makeEl(tagName);
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      const match = /\[(data-i18n(?:-title|-placeholder)?)\]/.exec(selector);
      if (!match) return [];
      return [...elements.values()].filter(
        (el) => el.getAttribute(match[1]) !== null
      );
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return { document, elements };
}

// --- fake clock --------------------------------------------------------------
// A login test must not wait 4 s for the "waiting for the server" hint, nor 45 s
// for the retries: the clock is driven by hand instead.
function makeClock() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map();

  function schedule(fn, ms, interval) {
    const id = nextId++;
    jobs.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, interval });
    return id;
  }

  return {
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)),
    clearTimeout: (id) => jobs.delete(id),
    clearInterval: (id) => jobs.delete(id),
    pending: () => jobs.size,
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 10000; guard++) {
        let next = null;
        for (const [id, job] of jobs) {
          if (job.at <= target && (!next || job.at < next.job.at)) {
            next = { id, job };
          }
        }
        if (!next) break;
        now = next.job.at;
        if (next.job.interval) next.job.at = now + next.job.interval;
        else jobs.delete(next.id);
        next.job.fn();
      }
      now = target;
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

// --- a login page in a box ---------------------------------------------------
// Loads common.js + netMonitor.js + logic.js into a fresh vm context, in the same
// order and with the same globals as the real page.
function createPage(options = {}) {
  const clock = makeClock();
  const { document, elements } = makeDocument(html);

  const storage = new Map(Object.entries(options.storage || { lang: "en" }));
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };

  const bridge = {
    loaded: [],
    tokenUpdates: [],
    LoadNewPage(page) {
      bridge.loaded.push(page);
    },
    async OutboxUpdateToken(username, token) {
      bridge.tokenUpdates.push({ username, token });
    },
  };

  // Requests are answered by the test: /ping and /branches always answer, while
  // /logme is served from a queue so a scenario can hold the answer back.
  const loginQueue = [];
  const requests = [];

  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    localStorage,
    document,
    bridge,
    AbortController: class {
      constructor() {
        this.signal = { aborted: false };
      }
      abort() {
        this.signal.aborted = true;
      }
    },
    fetch(url, init) {
      const target = String(url);
      requests.push(target);
      if (target.endsWith("/ping")) return Promise.resolve(jsonResponse(200, {}));
      if (target.endsWith("/branches")) {
        return Promise.resolve(jsonResponse(200, { branches: [] }));
      }
      if (target.endsWith("/logme")) {
        const handler = loginQueue.shift();
        if (!handler) return new Promise(() => {}); // never answers
        return handler(init);
      }
      return Promise.resolve(jsonResponse(404, {}));
    },
    addEventListener() {},
    removeEventListener() {},
  };
  // The page scripts treat window as the global object.
  ctx.window = ctx;

  ctx.setTimeout = clock.setTimeout;
  ctx.setInterval = clock.setInterval;
  ctx.clearTimeout = clock.clearTimeout;
  ctx.clearInterval = clock.clearInterval;
  // Date.now() follows the fake clock: that is what the elapsed seconds use.
  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(clock.now());
  }
  FakeDate.now = () => clock.now();
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  ctx.Date = FakeDate;

  vm.createContext(ctx);

  // A network-level failure has to be a TypeError of THIS realm, exactly as a
  // real fetch failure is, otherwise loginFetch() would not classify it as
  // transient and would not retry it.
  const networkError = () =>
    vm.runInContext('new TypeError("Failed to fetch")', ctx);

  for (const file of [
    path.join(RENDERER, "common.js"),
    path.join(RENDERER, "netMonitor.js"),
    path.join(RENDERER, "LoginPage", "logic.js"),
  ]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  }

  const el = (id) => elements.get(id);
  return {
    ctx,
    clock,
    document,
    elements,
    el,
    bridge,
    localStorage,
    storage,
    requests,
    networkError,
    // Queue the answer of the next /logme request.
    answerLogin(handler) {
      loginQueue.push(handler);
    },
    login(username, password) {
      elements.get("UsernameInput").value = username;
      elements.get("PassInput").value = password;
      return vm.runInContext("doLogin()", ctx);
    },
  };
}

// --- scenarios ---------------------------------------------------------------
async function main() {
  log("Insurance — login attempt feedback");

  await check("the phase line is a polite live region in the page", () => {
    ok(/id="LoginProgress"/.test(html), "missing #LoginProgress in index.html");
    ok(/aria-live="polite"/.test(html), "the phase line must be announced");
    ok(/id="LoginSpinner"/.test(html), "missing #LoginSpinner in index.html");
    ok(/id="SubmitLabel"/.test(html), "missing #SubmitLabel in index.html");
  });

  await check("an idle form shows no spinner and no phase", () => {
    const page = createPage();
    eq(page.el("LoginProgress").className, "login-progress", "phase line hidden");
    eq(page.el("LoginProgressText").textContent, "", "no phase text");
    eq(page.el("SubmitLabel").textContent, "Login", "button label");
    ok(!page.el("LoginSpinner").classList.contains("is-done"), "no check mark");
    eq(page.el("SubmitButton").disabled, false, "submit enabled");
    ok(!page.document.body.classList.contains("login-busy"), "body not busy");
  });

  await check(
    "an attempt in flight freezes the form and names its phase",
    async () => {
      const page = createPage();
      page.answerLogin(() => new Promise(() => {})); // the server never answers
      void page.login("worker", "secret");

      // The request is the first thing an attempt does.
      ok(page.document.body.classList.contains("login-busy"), "body not busy");
      eq(page.el("SubmitButton").disabled, true, "submit disabled");
      eq(page.el("UsernameInput").disabled, true, "username disabled");
      eq(page.el("PassInput").disabled, true, "password disabled");
      eq(page.el("BranchInput").disabled, true, "branch disabled");
      eq(page.el("LoginForm").getAttribute("aria-busy"), "true", "form aria-busy");
      eq(page.el("SubmitLabel").textContent, "Signing in…", "button label");
      ok(page.el("LoginProgress").classList.contains("visible"), "phase line shown");
      eq(
        page.el("LoginProgressText").textContent,
        "Signing in…",
        "signing-in phase"
      );

      await settleDeep();
      eq(page.el("LoginProgressText").textContent, "Signing in…", "still signing in");
      ok(
        page.requests.some((url) => url.endsWith("/logme")),
        "the login request was sent straight away"
      );
    }
  );

  await check("a silent server is named, with the seconds waited", async () => {
    const page = createPage();
    page.answerLogin(() => new Promise(() => {}));
    void page.login("worker", "secret");
    await settleDeep();
    eq(page.el("LoginProgressText").textContent, "Signing in…", "before the hint");

    page.clock.advance(4000);
    eq(
      page.el("LoginProgressText").textContent,
      "Waiting for the server… (4 s)",
      "after 4 s of silence"
    );
    page.clock.advance(2000);
    eq(
      page.el("LoginProgressText").textContent,
      "Waiting for the server… (6 s)",
      "the seconds keep counting"
    );
  });

  await check("a transient failure shows the retry counter", async () => {
    const page = createPage();
    const netError = page.networkError();
    page.answerLogin(() => Promise.reject(netError));
    page.answerLogin(() => new Promise(() => {}));
    void page.login("worker", "secret");
    await settleDeep();
    eq(
      page.el("LoginProgressText").textContent,
      "Server unreachable — retrying… (2/3)",
      "retry phase"
    );
    ok(page.document.body.classList.contains("login-busy"), "still busy");

    page.clock.advance(800); // backoff before the second attempt
    await settleDeep();
    eq(
      page.el("LoginProgressText").textContent,
      "Signing in…",
      "second attempt running"
    );
  });

  await check(
    "a refused login ends the attempt with the error and a usable form",
    async () => {
      const page = createPage();
      page.answerLogin(() =>
        Promise.resolve(
          jsonResponse(401, { error: "Invalid username or password" })
        )
      );
      await page.login("worker", "wrong");
      await settleDeep();

      ok(!page.document.body.classList.contains("login-busy"), "no longer busy");
      eq(page.el("SubmitButton").disabled, false, "submit enabled");
      eq(page.el("UsernameInput").disabled, false, "username enabled");
      eq(page.el("PassInput").disabled, false, "password enabled");
      eq(page.el("LoginForm").getAttribute("aria-busy"), null, "aria-busy cleared");
      eq(page.el("SubmitLabel").textContent, "Login", "button label back");
      eq(page.el("LoginProgress").className, "login-progress", "phase line hidden");
      eq(page.el("LoginProgressText").textContent, "", "phase text cleared");
      ok(
        page.el("AuthCard").classList.contains("card-error"),
        "card must flash as failed"
      );
      ok(!page.el("LoginSpinner").classList.contains("is-done"), "no check mark");
      eq(
        page.el("DisplayMsg").textContent,
        "Invalid username or password",
        "error message"
      );
      eq(page.el("DisplayMsg").className, "msg error", "error styling");
      eq(page.bridge.loaded.length, 0, "the work page must not open");
    }
  );

  await check(
    "a successful login ends green, stores the session and opens the work page",
    async () => {
      const page = createPage();
      page.el("BranchInput").value = "ГКПП Лесово";
      page.answerLogin(() =>
        Promise.resolve(
          jsonResponse(200, { token: "tok-1", username: "worker", role: "2" })
        )
      );
      await page.login("worker", "secret");
      await settleDeep();

      ok(page.el("LoginSpinner").classList.contains("is-done"), "check mark shown");
      ok(
        page.el("AuthCard").classList.contains("card-success"),
        "card must show success"
      );
      ok(
        page.el("LoginProgress").classList.contains("visible"),
        "the phase line keeps the outcome visible"
      );
      ok(
        page.el("LoginProgress").classList.contains("success"),
        "the outcome is green"
      );
      eq(
        page.el("LoginProgressText").textContent,
        "Login successful — loading…",
        "success text"
      );
      eq(
        page.el("SubmitLabel").textContent,
        "Login successful — loading…",
        "button confirms the outcome"
      );
      eq(page.el("SubmitButton").disabled, true, "form frozen while loading");
      ok(
        !page.document.body.classList.contains("login-busy"),
        "the spinner must stop spinning"
      );
      eq(page.storage.get("token"), "tok-1", "token stored");
      eq(page.storage.get("username"), "worker", "username stored");
      eq(page.storage.get("branch"), "ГКПП Лесово", "branch stored");
      eq(
        page.bridge.tokenUpdates,
        [{ username: "worker", token: "tok-1" }],
        "queued requests get the new token"
      );
      eq(
        page.bridge.loaded,
        ["renderer/WorkPage/WorkPage.html"],
        "the work page opens"
      );
    }
  );

  await check(
    "a dead server ends the attempt instead of spinning forever",
    async () => {
      const page = createPage();
      const netError = page.networkError();
      page.answerLogin(() => Promise.reject(netError));
      page.answerLogin(() => Promise.reject(netError));
      page.answerLogin(() => Promise.reject(netError));
      void page.login("worker", "secret");
      await settleDeep();
      page.clock.advance(800); // backoff before attempt 2
      await settleDeep();
      page.clock.advance(1600); // backoff before attempt 3
      await settleDeep();
      await settleDeep();

      ok(!page.document.body.classList.contains("login-busy"), "no longer busy");
      eq(page.el("SubmitButton").disabled, false, "the form is usable again");
      ok(
        page.el("AuthCard").classList.contains("card-error"),
        "card must flash as failed"
      );
      eq(page.el("DisplayMsg").textContent, "Server Error", "server error message");
      eq(page.bridge.loaded.length, 0, "the work page must not open");
    }
  );

  await check("a second submit during an attempt is ignored", async () => {
    const page = createPage();
    page.answerLogin(() => new Promise(() => {}));
    void page.login("worker", "secret");
    await settleDeep();
    const sent = () =>
      page.requests.filter((url) => url.endsWith("/logme")).length;
    eq(sent(), 1, "one request");
    void vm.runInContext("doLogin()", page.ctx);
    await settleDeep();
    eq(sent(), 1, "the second submit must not send another request");
  });

  await check("the eye is a keyboard-reachable button bound to the password field", () => {
    // A <div> could only be clicked; a button is reachable with Tab and Enter.
    ok(/<button[^>]*id="VisIcon"/.test(html), "the eye must be a <button>");
    ok(
      /aria-controls="PassInput"/.test(html),
      "the eye must name the field it reveals"
    );
  });

  await check("the eye toggles the password between masked and readable", () => {
    const page = createPage();
    const eye = page.el("VisIcon");
    const pass = page.el("PassInput");

    // The page renders the field masked, so the button starts offering to show.
    eq(pass.type, "password", "the field starts masked");
    eq(eye.getAttribute("aria-pressed"), "false", "the eye reports \"hidden\"");
    eq(eye.title, "Show password", "the label offers to show the password");
    eq(eye.getAttribute("aria-label"), "Show password", "screen readers agree");

    eye.dispatch("click");
    eq(pass.type, "text", "the password becomes readable");
    eq(eye.getAttribute("aria-pressed"), "true", "the eye reports \"readable\"");
    eq(eye.title, "Hide password", "the label now offers to hide it");
    eq(eye.getAttribute("aria-label"), "Hide password", "screen readers agree");

    eye.dispatch("click");
    eq(pass.type, "password", "the password is masked again");
    eq(eye.getAttribute("aria-pressed"), "false", "the eye reports \"hidden\"");
    eq(eye.title, "Show password", "the label offers to show it again");
  });

  await check("the eye's label follows the selected language", () => {
    const page = createPage();
    const eye = page.el("VisIcon");
    eq(eye.title, "Show password", "english label");
    page.el("LangButton").dispatch("click");
    eq(eye.title, "Покажи паролата", "bulgarian label after switching");
    eye.dispatch("click");
    eq(eye.title, "Скрий паролата", "the readable state is translated too");
  });

  await check("every phase has a Bulgarian and an English string", () => {
    const page = createPage();
    const rows = vm.runInContext(
      "['login.signingIn','login.retrying'," +
        "'login.waitingServer','login.offline','login.success','login.elapsed']" +
        ".map((key) => [key, I18N.en[key], I18N.bg[key]])",
      page.ctx
    );
    eq(rows.length, 6, "key count");
    for (const [key, en, bg] of rows) {
      ok(typeof en === "string" && en.length > 0, `${key} missing in en`);
      ok(typeof bg === "string" && bg.length > 0, `${key} missing in bg`);
    }
    const elapsed = rows.find((row) => row[0] === "login.elapsed");
    ok(elapsed[1].includes("{seconds}"), "en needs a {seconds} slot");
    ok(elapsed[2].includes("{seconds}"), "bg needs a {seconds} slot");
  });

  log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
