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

// Login requests are retried a few times with a per-attempt timeout. A login
// is idempotent from the client's point of view (the server deletes any prior
// token before issuing a new one), so a transient network blip or server 5xx —
// e.g. the daily 13:00-17:00 window — auto-recovers instead of showing a bare
// "Server Error" and requiring the worker to retry by hand.
//
// onProgress({ attempt, total, retrying }) is called before each retry and again
// when the retry actually starts, so the caller can show
// "Server unreachable — retrying… (2/3)" in the attempt's phase line.
const LOGIN_TIMEOUT_MS = 15000;
const LOGIN_MAX_ATTEMPTS = 3;

async function loginFetch(username, password, branch, onProgress) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  let lastNetworkError = null;
  for (let attempt = 0; attempt < LOGIN_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      report({ attempt: attempt + 1, total: LOGIN_MAX_ATTEMPTS, retrying: true });
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
      // The new request starts now: back to "contacting the server" so the
      // "waiting for the server" hint is armed again for this attempt.
      report({ attempt: attempt + 1, total: LOGIN_MAX_ATTEMPTS, retrying: false });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/logme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, branch: branch || "" }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } catch (err) {
      clearTimeout(timer);
      // Retry only transient failures: timeouts and network-level errors.
      if (err.name === "AbortError" || err instanceof TypeError) {
        lastNetworkError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastNetworkError || new Error("Login request failed");
}

// ---------------------------------------------------------------------------
// Login attempt feedback.
//
// A login can take a while — up to three 15 s server attempts — and without
// feedback the worker cannot tell a slow server from a dead window, so they
// either wait blindly or click Login again. While an attempt is in flight the
// form is frozen, the button carries a spinner, the phase line under the form
// says what is happening (and for how long the server has been quiet), and a
// bar slides along the top edge of the card. Every path out of doLogin() ends in
// a visible terminal state: green + "Login successful — loading…" while the work
// page loads, or red + shake + the error message with the form usable again.
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
  const offline = !!(netMonitor && netMonitor.getState().status === "offline");
  switch (phaseKey) {
    case "login.signingIn":
    case "login.retrying":
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
    const { res, data } = await loginFetch(
      UserName.value,
      Pass.value,
      BranchInput ? BranchInput.value : "",
      (progress) => {
        if (progress.retrying) {
          setPhase("login.retrying", `${progress.attempt}/${progress.total}`);
        } else {
          setPhase("login.signingIn");
        }
      }
    );

    if (!res.ok) {
      // The server answered and refused: a finished attempt, not a slow one.
      endBusy("error");
      setMessage(translateError(data.error) || t("accessDenied"), true);
      if (Pass) {
        Pass.focus();
        Pass.select();
      }
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
    // A dead end (timeout on every attempt, unexpected failure): back to a
    // usable form with a red card, never a spinner that runs forever.
    endBusy("error");
    setMessage(t("serverError"), true);
  }
}

// Populate the branch dropdown from the server so newly created branches appear
// and disabled branches are excluded. The hardcoded <option> list in index.html
// stays as an offline fallback; when the server answers, it is replaced here.
async function loadBranches() {
  try {
    const res = await fetch(`${API_BASE}/branches`, {
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    const branches = Array.isArray(data.branches) ? data.branches : [];
    if (branches.length === 0 || !BranchInput) return;

    const current = BranchInput.value;
    BranchInput.innerHTML = "";
    for (const b of branches) {
      const opt = document.createElement("option");
      opt.value = b.Name;
      opt.textContent = b.Name;
      BranchInput.appendChild(opt);
    }

    // Restore the previously selected branch when it is still available.
    const preferred = current || localStorage.getItem("branch") || "";
    if (
      preferred &&
      [...BranchInput.options].some((o) => o.value === preferred)
    ) {
      BranchInput.value = preferred;
    }
  } catch (err) {
    // Network/parse errors: keep the static fallback list.
    console.error("Failed to load branches:", err);
  }
}

LoginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  doLogin();
});

loadBranches();

// Start the reachability monitor so the worker can see, before logging in,
// whether the server is up (green) or unreachable (red) — and whether it is
// recovering on its own during an intermittent outage. The handle is kept so a
// login in flight can say "no connection" instead of "signing in" when the
// server is already known to be down.
try {
  netMonitor = startNetMonitor({
    apiBase: API_BASE,
    statusEl: NetStatus || undefined,
    labels: {
      online: t("net.connected"),
      offline: t("net.offline"),
      checking: t("net.checking"),
    },
  });
} catch (err) {
  console.error("Failed to start network monitor:", err);
}
