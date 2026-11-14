"use strict";

const VisIcon = document.getElementById("VisIcon");
const Pass = document.getElementById("PassInput");
const UserName = document.getElementById("UsernameInput");
const BranchInput = document.getElementById("BranchInput");
const DisplayMsg = document.getElementById("DisplayMsg");
const LoginForm = document.getElementById("LoginForm");
const LangButton = document.getElementById("LangButton");
const NetStatus = document.getElementById("NetStatus");
const AuthCard = document.getElementById("AuthCard");
const SubmitButton = document.getElementById("SubmitButton");
const SubmitLabel = document.getElementById("SubmitLabel");
const LoginSpinner = document.getElementById("LoginSpinner");
const LoginProgress = document.getElementById("LoginProgress");
const LoginProgressText = document.getElementById("LoginProgressText");

// Handle of the reachability monitor started at the bottom of this file. It is
// read while a login is in flight, so the phase line can say "no connection"
// when the monitor already knows the server is unreachable.
let netMonitor = null;

function setMessage(text, isError) {
  if (!DisplayMsg) return;
  DisplayMsg.textContent = text;
  DisplayMsg.className = "msg " + (isError ? "error" : "success");
  // The diagnosis of the previous failure lives in the tooltip; a new message
  // must not inherit it.
  DisplayMsg.title = "";
  if (!text) DisplayMsg.className = "msg";
}

// Password visibility. The eye button is part of the page markup; its SVG comes
// from common.js (one icon for every password field in the app) and
// setupPasswordToggle keeps aria-pressed, the icon and the label in agreement
// with the field's real type, so "eye with slash" always means "readable now".
if (VisIcon) VisIcon.innerHTML = PASSWORD_EYE_ICON_SVG;
const passwordToggle = setupPasswordToggle(VisIcon, Pass);

function syncLangButton() {
  if (!LangButton) return;
  LangButton.textContent = getLang() === "bg" ? "EN" : "BG";
}
if (LangButton) {
  LangButton.addEventListener("click", () => {
    toggleLang();
    syncLangButton();
    // A language switch re-translates the static labels (including the button
    // label), so the phase of an attempt in flight is re-applied afterwards.
    if (busy) renderAttempt();
    // The eye button's label is translated too (and not marked up with
    // data-i18n-title, since its text follows the field's state).
    if (passwordToggle) passwordToggle.sync();
  });
}
syncLangButton();

// Login requests are retried a few times, each with a deadline that covers the
// WHOLE exchange: sending the credentials, receiving the headers AND reading the
// body. Reading the body outside the deadline was a real trap: the headers
// arrived, the body stalled on a bad link, and the form sat frozen with a
// spinner that never timed out, never retried and never showed an error -
// "the program just hangs at login" - while the server had already accepted the
// login.
//
// The server rotates the token on every successful /logme (it deletes the prior
// one), so a retry is only safe when we store the token of the LAST answer.
// `requestId` travels with every attempt of one login so the server can answer
// a repeated attempt with the same session instead of rotating the token again
// (the client half of the idempotency contract; harmless if the server ignores
// it).
//
// onProgress({ attempt, total, retrying, timedOut }) is called before each retry
// and again when the retry actually starts, so the caller can show
// "Server unreachable — retrying… (2/3)" (or "...the server is slow...") in the
// attempt's phase line.
const LOGIN_TIMEOUT_MS = 30000;
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_RETRY_BASE_MS = 1500;

// One id per login attempt sequence (all retries share it).
function makeLoginRequestId() {
  const random = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `login-${Date.now().toString(36)}-${random}`;
}

function describeLoginError(err) {
  if (!err) return "unknown error";
  if (err.timedOut) return `no answer within ${Math.round(LOGIN_TIMEOUT_MS / 1000)} s`;
  if (err.name === "AbortError") return "aborted";
  if (err instanceof TypeError) return "network-level failure (fetch rejected)";
  return err.message || String(err);
}

function logLoginAttempt(requestId, attempt, status, durationMs, err) {
  const line =
    `${requestId} attempt ${attempt}/${LOGIN_MAX_ATTEMPTS}: ` +
    (status != null ? `HTTP ${status}` : describeLoginError(err)) +
    `, ${durationMs} ms`;
  console.warn(`[login] ${line}`);
  // Persisted by the main process (userData/logs/network.log) so an
  // intermittent failure leaves a trace a worker can hand over.
  if (typeof logEvent === "function") logEvent("login", line);
}

function loginTimeoutError() {
  const err = new Error(`No answer within ${Math.round(LOGIN_TIMEOUT_MS / 1000)} s`);
  err.timedOut = true;
  return err;
}

// Read the answer as text first: a captive portal, a proxy or the hosting
// firewall answers with HTML, and `res.json()` alone cannot tell that apart from
// a broken reply. Falls back to json() for a Response that has no text().
async function readLoginAnswer(res) {
  if (typeof res.text === "function") {
    const raw = await res.text();
    try {
      return { raw, data: JSON.parse(raw) };
    } catch {
      return { raw, data: null };
    }
  }
  try {
    return { raw: "", data: await res.json() };
  } catch {
    return { raw: "", data: null };
  }
}

async function loginFetch(username, password, branch, onProgress) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  const requestId = makeLoginRequestId();
  let lastError = null;

  for (let attempt = 0; attempt < LOGIN_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      report({
        attempt: attempt + 1,
        total: LOGIN_MAX_ATTEMPTS,
        retrying: true,
        timedOut: !!(lastError && lastError.timedOut),
      });
      await new Promise((r) =>
        setTimeout(r, LOGIN_RETRY_BASE_MS * Math.pow(2, attempt - 1))
      );
      // The new request starts now: back to "contacting the server" so the
      // "waiting for the server" hint is armed again for this attempt.
      report({ attempt: attempt + 1, total: LOGIN_MAX_ATTEMPTS, retrying: false });
    }

    const controller = new AbortController();
    let timer = null;
    // The deadline is a promise, not just an abort: a fetch that ignores the
    // signal (or a body that never ends) must still end the attempt.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        reject(loginTimeoutError());
      }, LOGIN_TIMEOUT_MS);
    });
    deadline.catch(() => {});
    const startedAt = Date.now();

    try {
      const res = await Promise.race([
        fetch(`${API_BASE}/logme`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            password,
            branch: branch || "",
            requestId,
          }),
          signal: controller.signal,
        }),
        deadline,
      ]);
      const answer = await Promise.race([readLoginAnswer(res), deadline]);
      logLoginAttempt(requestId, attempt + 1, res.status, Date.now() - startedAt, null);
      return { res, data: answer.data, raw: answer.raw };
    } catch (err) {
      logLoginAttempt(requestId, attempt + 1, null, Date.now() - startedAt, err);
      // Retry only transient failures: timeouts and network-level errors.
      if (err.timedOut || err.name === "AbortError" || err instanceof TypeError) {
        lastError = err;
        continue;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("Login request failed");
}

// An answer that is not ours: a captive portal, a proxy, or the hosting
// firewall. Returns "" when the answer came from the API (JSON), so callers can
// fall back to the normal error handling.
function describeBlockedAnswer(res, raw) {
  const body = String(raw || "").trim();
  if (!body || body.charAt(0) === "{") return "";
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
  return `${t("blockedBeforeServer")} (HTTP ${res.status}${title ? ` - ${title}` : ""})`;
}

// The server refuses a login when the submitted branch is disabled or unknown
// ("Branch is disabled" / "Branch not found"). That needs a fresh branch list,
// not another password attempt - and it is why switching branches used to be the
// only way in on a slow link.
function isBranchRejection(data) {
  const message = String((data && data.error) || "");
  return /branch/i.test(message) && /(disabled|not found|invalid|unknown)/i.test(message);
}

// Ask the main process which stage of the connection is actually slow (DNS,
// TCP, TLS or the wait for the first byte). Runs only after a login has already
// failed, so it never delays the attempt itself; the result is logged and shown
// as the tooltip of the message area. This is what separates "the server is
// down" from "this network is slow or blocking us", which need different fixes.
async function explainLoginFailure(timedOut) {
  if (!window.bridge || typeof window.bridge.DiagnoseServer !== "function") return;
  let summary = null;
  try {
    summary = await window.bridge.DiagnoseServer();
  } catch (err) {
    console.error("Server diagnosis failed:", err);
    return;
  }
  if (!summary) return;
  const detail = describeDiagnosis(summary);
  console.warn("[login] server diagnosis:", summary, "->", detail);
  logEvent("login", `diagnosis (${timedOut ? "timeout" : "no answer"}): ${detail}`);
  // Long text belongs in the tooltip: the message area is small.
  if (DisplayMsg) DisplayMsg.title = detail;
}

function describeDiagnosis(d) {
  if (!d) return "";
  if (!d.ok) {
    if (d.stage === "dns") return `DNS lookup failed (${d.error || "unknown"})`;
    if (d.stage === "connect")
      return `Could not open a connection (${d.error || "unknown"})`;
    if (d.stage === "tls") return `TLS handshake failed (${d.error || "unknown"})`;
    if (d.stage === "timeout")
      return `No answer within ${Math.round((d.timeoutMs || 0) / 1000)} s`;
    return d.error || "The server could not be reached";
  }
  const dur = (ms) =>
    ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  const parts = [];
  if (d.dnsMs != null) parts.push(`DNS ${dur(d.dnsMs)}`);
  if (d.connectMs != null) parts.push(`connect ${dur(d.connectMs)}`);
  if (d.tlsMs != null) parts.push(`TLS ${dur(d.tlsMs)}`);
  if (d.ttfbMs != null) parts.push(`first byte ${dur(d.ttfbMs)}`);
  if (d.status != null) parts.push(`HTTP ${d.status}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Login attempt feedback.
//
// A login can take a while — up to three 30 s attempts on a link that answers
// slowly — and without feedback the worker cannot tell a slow server from a dead
// window, so they either wait blindly or click Login again. While an attempt is
// in flight the form is frozen, the button carries a spinner, the phase line
// under the form says what is happening (and for how long the server has been
// quiet), and a bar slides along the top edge of the card. Every path out of
// doLogin() ends in a visible terminal state: green + "Login successful —
// loading…" while the work page loads, or red + shake + the error message with
// the form usable again.
// ---------------------------------------------------------------------------

// How long the server may stay silent before the phase line says so explicitly.
const WAITING_HINT_MS = 4000;

let busy = false; // an attempt is in flight
let phaseKey = "login"; // i18n key of the current phase
let phaseSuffix = ""; // e.g. "2/3" for a retry
let phaseStartedAt = 0; // Date.now() when the phase began (drives the seconds)
let waitingTimer = null; // fires the "waiting for the server" escalation
let tickTimer = null; // repaints the seconds while waiting

function elapsedSeconds() {
  return Math.max(0, Math.round((Date.now() - phaseStartedAt) / 1000));
}

// What the phase line should say right now. The reachability monitor adds
// context the request itself cannot: when the server is known to be
// unreachable, "no connection" explains a silent wait better than "signing in".
function attemptText() {
  // Only a confident outage may replace the phase. A single slow or dropped
  // /ping during a login would otherwise turn a request that is actually being
  // served into "No connection — the server is unreachable", which is how a
  // successful login came to look like a refused one.
  const netState = netMonitor ? netMonitor.getState() : null;
  const offline = !!(
    netState &&
    netState.status === "offline" &&
    (netState.consecutiveFailures || 0) >= 2
  );
  switch (phaseKey) {
    case "login.signingIn":
    case "login.retrying":
    case "login.retryingSlow":
    case "login.waitingServer": {
      if (offline) return t("login.offline");
      const text = t(phaseKey);
      const extra = [];
      if (phaseSuffix) extra.push(phaseSuffix);
      if (phaseKey === "login.waitingServer") {
        extra.push(
          t("login.elapsed").replace("{seconds}", String(elapsedSeconds()))
        );
      }
      return extra.length ? `${text} (${extra.join(", ")})` : text;
    }
    default:
      return t(phaseKey);
  }
}

function renderAttempt() {
  const text = attemptText();
  if (LoginProgressText) LoginProgressText.textContent = text;
  if (LoginProgress) {
    LoginProgress.className =
      "login-progress visible " +
      (phaseKey === "login.success" ? "success" : "pending");
  }
  if (SubmitLabel) {
    SubmitLabel.textContent =
      phaseKey === "login.success" ? t("login.success") : t("login.signingIn");
  }
}

function setPhase(key, suffix, keepSince) {
  phaseKey = key;
  phaseSuffix = suffix || "";
  // The escalation to "waiting for the server" must not restart the clock: the
  // seconds shown are how long the worker has been waiting, not how long the
  // current label has been on screen.
  if (!keepSince) phaseStartedAt = Date.now();
  if (waitingTimer) {
    clearTimeout(waitingTimer);
    waitingTimer = null;
  }
  // A silent server is escalated to an explicit "waiting for the server" phase,
  // so a 15 s timeout never looks like a frozen window.
  if (key !== "login.success") {
    waitingTimer = setTimeout(() => {
      if (busy) setPhase("login.waitingServer", phaseSuffix, true);
    }, WAITING_HINT_MS);
  }
  renderAttempt();
}

function setFormEnabled(enabled) {
  [BranchInput, UserName, Pass, SubmitButton].forEach((node) => {
    if (node) node.disabled = !enabled;
  });
  if (LoginForm) {
    if (enabled) LoginForm.removeAttribute("aria-busy");
    else LoginForm.setAttribute("aria-busy", "true");
  }
}

function beginBusy(key) {
  busy = true;
  document.body.classList.add("login-busy");
  if (AuthCard) AuthCard.classList.remove("card-success", "card-error");
  setMessage("", false);
  setFormEnabled(false);
  setPhase(key);
  if (tickTimer) clearInterval(tickTimer);
  // Repaint once a second so the elapsed seconds keep counting up.
  tickTimer = setInterval(() => {
    if (busy) renderAttempt();
  }, 1000);
}

// Ends an attempt without success: the form comes back to life and the card
// flashes red, so the worker sees that the attempt is over and can retry.
function endBusy(kind) {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (waitingTimer) {
    clearTimeout(waitingTimer);
    waitingTimer = null;
  }
  busy = false;
  document.body.classList.remove("login-busy");
  setFormEnabled(true);
  if (LoginSpinner) LoginSpinner.classList.remove("is-done");
  if (SubmitLabel) SubmitLabel.textContent = t("login");
  // The phase line only ever describes an attempt in flight: the outcome is the
  // card state plus the message area, so the line is cleared here.
  if (LoginProgress) LoginProgress.className = "login-progress";
  if (LoginProgressText) LoginProgressText.textContent = "";
  if (AuthCard) {
    AuthCard.classList.remove("card-success", "card-error");
    if (kind) {
      AuthCard.classList.add(kind === "error" ? "card-error" : "card-success");
    }
  }
}

// Ends an attempt successfully. The form stays frozen because the window is
// about to be replaced by the work page.
function showSuccess() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (waitingTimer) {
    clearTimeout(waitingTimer);
    waitingTimer = null;
  }
  busy = false;
  document.body.classList.remove("login-busy");
  if (LoginSpinner) LoginSpinner.classList.add("is-done");
  setPhase("login.success");
  if (AuthCard) {
    AuthCard.classList.remove("card-error");
    AuthCard.classList.add("card-success");
  }
}

async function doLogin() {
  // A submit that arrives while an attempt is already in flight is ignored: the
  // spinner on screen belongs to that attempt, not to the new click.
  if (busy) return;

  if (!UserName.value || !Pass.value) {
    setMessage(t("enterCredentials"), true);
    return;
  }

  beginBusy("login.signingIn");
  try {
    // The branch is part of the login request and the server refuses a branch
    // that is disabled or gone. Give the server's list a moment to arrive so the
    // value comes from the server rather than from the snapshot in index.html -
    // that snapshot is what used to make a login fail until the worker switched
    // branches by hand.
    await waitForBranches(BRANCHES_WAIT_MS);
    const branch = BranchInput ? BranchInput.value : "";
    logEvent(
      "login",
      `branch "${branch}" (${branchesVerified ? "server list" : "fallback list"})`
    );

    const { res, data, raw } = await loginFetch(
      UserName.value,
      Pass.value,
      branch,
      (progress) => {
        if (progress.retrying) {
          // A timed-out attempt is a different story from an unreachable host:
          // on a slow link the first attempt often succeeded on the server and
          // only the answer was late, so say "slow", not "unreachable".
          setPhase(
            progress.timedOut ? "login.retryingSlow" : "login.retrying",
            `${progress.attempt}/${progress.total}`
          );
        } else {
          setPhase("login.signingIn");
        }
      }
    );

    if (!res.ok) {
      // The server answered and refused: a finished attempt, not a slow one.
      endBusy("error");
      // A rejected branch means the dropdown is out of date: refresh it now so
      // the next click can work instead of leaving the worker to guess.
      if (isBranchRejection(data)) void loadBranches(true, true);
      // A 4xx/5xx that is not our JSON did not come from the API at all
      // (hosting firewall, proxy, antivirus). Calling that "Access Denied"
      // sent workers hunting for a password problem that did not exist.
      setMessage(
        (data && data.error ? translateError(data.error) : "") ||
          describeBlockedAnswer(res, raw) ||
          t("accessDenied"),
        true
      );
      if (Pass) {
        Pass.focus();
        Pass.select();
      }
      return;
    }

    // A 2xx that carries no token is not a login: it is a captive portal, a
    // proxy page or a truncated answer. Storing an empty token here used to
    // "succeed", open the work page and bounce the worker straight back to this
    // form, which looks exactly like being refused.
    if (!data || !data.token) {
      endBusy("error");
      setMessage(describeBlockedAnswer(res, raw) || t("login.noToken"), true);
      return;
    }

    showSuccess();

    localStorage.setItem("token", data.token || "");
    localStorage.setItem("username", data.username || "");
    localStorage.setItem("role", data.role || "");
    // The branch is selected at login and attached to every insurance the
    // worker creates (the add-insurance form no longer has a branch field).
    localStorage.setItem("branch", BranchInput ? BranchInput.value : "");

    // Policies queued while the session was expired (or before a restart)
    // resume with the fresh token. Only this user's own requests are updated.
    if (window.bridge && typeof window.bridge.OutboxUpdateToken === "function") {
      try {
        await window.bridge.OutboxUpdateToken(data.username || "", data.token || "");
      } catch (err) {
        console.error("Failed to hand the new token to the outbox:", err);
      }
    }

    if (window.bridge && typeof window.bridge.LoadNewPage === "function") {
      window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
    } else {
      console.error(
        "Cannot open the work page: window.bridge.LoadNewPage is missing"
      );
    }
  } catch (error) {
    console.error("Error: ", error);
    // A dead end (deadline on every attempt, unexpected failure): back to a
    // usable form with a red card, never a spinner that runs forever. The
    // message names what actually happened instead of a bare "Server Error",
    // and a main-process diagnosis says which stage is slow.
    endBusy("error");
    const timedOut = !!(error && error.timedOut);
    let message = timedOut ? t("login.timeout") : t("login.networkFailed");
    // If the branch list never arrived, the branch that was just submitted came
    // from the build-time snapshot. Say so: it is actionable, and it is the
    // difference between "wrong password" and "wrong branch".
    if (branchFetchFailed) message += " " + t("login.branchListUnverified");
    setMessage(message, true);
    logEvent("login", `failed: ${describeLoginError(error)}`);
    void explainLoginFailure(timedOut);
  }
}

// Populate the branch dropdown from the server so newly created branches appear
// and disabled branches are excluded.
//
// This is not cosmetic: the branch is sent with /logme and the server refuses a
// login for a branch that is disabled or no longer exists. The hardcoded
// <option> list in index.html is only a build-time snapshot, so falling back to
// it on a slow link is what made a worker unable to log in until they happened
// to pick another option. Therefore:
//   * the list is retried, and retried again when the network comes back;
//   * a login waits briefly for it, so the submitted branch comes from the
//     server, not from the snapshot;
//   * a selection the server no longer offers is announced, never swapped
//     silently (the branch is also stamped on every policy the worker creates);
//   * a login refused because of the branch refreshes the list on the spot.
//
// It runs next to the login request, on the same link, so it gets a deadline of
// its own: without one, a stalled connection leaves this request (and its
// socket) hanging for as long as the operating system allows, competing with
// the login for a saturated uplink.
const BRANCHES_TIMEOUT_MS = 8000;
const BRANCHES_MAX_ATTEMPTS = 3;
const BRANCHES_RETRY_BASE_MS = 1200;
// How long a login waits for the list before going ahead with what it has.
const BRANCHES_WAIT_MS = 3000;

// True once the dropdown holds the server's own list. While it is false the
// options are the snapshot from index.html and the branch being sent may be
// stale, which the worker (and support) must be able to tell.
let branchesVerified = false;
// True when the last fetch failed at the network level (as opposed to the
// server answering with an empty list).
let branchFetchFailed = false;
let branchesLoading = null;

function applyBranches(branches, options = {}) {
  if (!BranchInput) return;
  const names = branches
    .map((b) => (b && (b.Name ?? b.name) ? String(b.Name ?? b.name) : ""))
    .filter(Boolean);
  if (names.length === 0) return;

  const current = BranchInput.value;
  BranchInput.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    BranchInput.appendChild(opt);
  }

  // Keep the worker's branch when the server still offers it (their current
  // choice first, then the one they used last time).
  const stored = (() => {
    try {
      return localStorage.getItem("branch") || "";
    } catch {
      return "";
    }
  })();
  const wanted = [current, stored].find((n) => n && names.includes(n));
  if (wanted) {
    BranchInput.value = wanted;
    return;
  }

  // The branch this worker was on is gone (disabled, renamed, removed). Say so
  // instead of silently logging them in under a different branch.
  BranchInput.value = names[0];
  if (current && current !== names[0] && !options.silent) {
    setMessage(
      fmt(t("branchChanged"), { from: current, to: names[0] }),
      false
    );
    logEvent(
      "login",
      `branch "${current}" is no longer offered; using "${names[0]}"`
    );
  }
}

async function fetchBranchesOnce(silent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRANCHES_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/branches`, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const branches = Array.isArray(data.branches) ? data.branches : [];
    if (branches.length === 0) {
      // An empty list is an answer, not a network problem: nothing to swap in.
      console.warn("[branches] the server returned no branches");
      return false;
    }
    applyBranches(branches, { silent });
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function loadBranches(force, silent) {
  if (branchesLoading && !force) return branchesLoading;
  const run = (async () => {
    for (let attempt = 1; attempt <= BRANCHES_MAX_ATTEMPTS; attempt++) {
      try {
        const ok = await fetchBranchesOnce(silent === true);
        branchFetchFailed = false;
        if (ok) branchesVerified = true;
        return ok;
      } catch (err) {
        branchFetchFailed = true;
        console.error(
          `[branches] attempt ${attempt}/${BRANCHES_MAX_ATTEMPTS} failed:`,
          err
        );
        if (attempt < BRANCHES_MAX_ATTEMPTS) {
          await new Promise((r) =>
            setTimeout(r, BRANCHES_RETRY_BASE_MS * Math.pow(2, attempt - 1))
          );
        }
      }
    }
    logEvent("login", "could not load the branch list from the server");
    return false;
  })();
  branchesLoading = run;
  run.finally(() => {
    if (branchesLoading === run) branchesLoading = null;
  });
  return run;
}

// Give the list a short chance to arrive before a login is sent, so the branch
// comes from the server whenever it can. Bounded: a slow list must not block
// the login for long.
async function waitForBranches(ms) {
  if (branchesVerified || !branchesLoading) return;
  let timer = null;
  try {
    await Promise.race([
      branchesLoading,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

LoginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doLogin();
});

// A forced logout (expired token, or a token replaced by a newer login) leaves a
// one-shot notice behind: without it the worker is dropped on this form with no
// explanation, which reads as "the program will not let me in".
(function showLoginNotice() {
  let notice = null;
  try {
    notice = localStorage.getItem("loginNotice");
    if (notice) localStorage.removeItem("loginNotice");
  } catch {
    notice = null;
  }
  if (notice) setMessage(t(notice), true);
})();

loadBranches();

// The network came back: if the dropdown is still the build-time snapshot, get
// the real list (a stale branch is refused by the server at login).
window.addEventListener("online", () => {
  if (!branchesVerified) loadBranches();
});

// Start the reachability monitor so the worker can see, before logging in,
// whether the server is up (green), slow (amber) or unreachable (red) — and
// whether it is recovering on its own during an intermittent outage. The handle
// is kept so a login in flight can say "no connection" instead of "signing in"
// when the server is already known to be down.
try {
  netMonitor = startNetMonitor({
    apiBase: API_BASE,
    statusEl: NetStatus || undefined,
    labels: {
      online: t("net.connected"),
      offline: t("net.offline"),
      checking: t("net.checking"),
      slow: t("net.slow"),
    },
  });
} catch (err) {
  console.error("Failed to start network monitor:", err);
}
