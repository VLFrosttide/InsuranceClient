"use strict";

// Lightweight client-side network monitor for the Insurance desktop client.
//
// It pings the server's /ping endpoint (which never touches the database) on a
// fixed interval and shows a small status pill so a worker can see at a glance
// whether the server is reachable *before* trying to log in. Every state
// transition is logged with a timestamp, so an intermittent outage (e.g. the
// daily 13:00-17:00 login failures) leaves a trail in the DevTools console for
// correlation with the server-side access log.
//
// Reachability is judged by whether an HTTP response comes back at all: a 2xx,
// a 404, or a 503 all mean "the server is up" — only a network-level failure or
// a timeout means "unreachable". This makes the monitor robust even against a
// server that has not been updated with a /ping route yet.
//
// A slow answer is not an outage. On a jittery link /ping can take several
// seconds and fail once in a while while the server is still answering and still
// logging workers in, so:
//   * a slow-but-successful probe reports "Slow connection", not "Offline";
//   * a single failed probe keeps the previous state; only `offlineAfterFailures`
//     consecutive failures turn the pill red.
// Reporting a false outage during a login is what made workers believe the app
// had refused them while the server had in fact accepted the login.
//
// Usage: startNetMonitor({ apiBase, statusEl, intervalMs, timeoutMs })
// Returns { stop, getState, check } — `check` runs one probe on demand.

function startNetMonitor(options = {}) {
  const apiBase = String(
    options.apiBase !== undefined
      ? options.apiBase
      : typeof API_BASE !== "undefined"
        ? API_BASE
        : ""
  ).replace(/\/+$/, "");

  const intervalMs = Number(options.intervalMs) || 15000;
  const timeoutMs = Number(options.timeoutMs) || 12000;
  // A probe that answers, but slowly, is not an outage: the link is bad
  // (jitter, saturated uplink) while the server is still serving requests and
  // still accepting logins. Reporting it as "offline" is what makes a worker
  // believe the program is broken while their login has already gone through.
  const slowMs = Number(options.slowMs) || 4000;
  // One failed probe is a blip. Only this many failures in a row mean the
  // server is really unreachable; until then the previous state is kept, so a
  // single dropped /ping cannot paint the pill red during a login.
  const offlineAfterFailures = Number(options.offlineAfterFailures) || 2;
  const statusEl = options.statusEl || null;
  const labels = Object.assign(
    { online: "Connected", offline: "Offline", checking: "Checking…", slow: "Slow connection" },
    options.labels || {}
  );

  if (!apiBase) {
    console.warn("[netMonitor] No API base configured; network monitor disabled.");
    return { stop: () => {}, getState: () => ({ status: "unknown" }) };
  }

  const state = {
    status: "unknown", // "online" | "offline" | "unknown"
    slow: false, // online, but the last probe was slower than slowMs
    latencyMs: null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };

  let stopped = false;
  let timer = null;
  let checking = false;

  function iso() {
    return new Date().toISOString();
  }

  function render() {
    if (!statusEl) return;
    const cls =
      state.status === "online"
        ? state.slow
          ? "slow"
          : "online"
        : state.status === "offline"
          ? "offline"
          : "checking";
    statusEl.textContent =
      state.status === "online" && state.slow
        ? labels.slow || labels.online
        : labels[state.status] || labels.checking;
    statusEl.className = "net-status " + cls;
    statusEl.title =
      state.latencyMs != null
        ? "Last check: " + state.latencyMs + " ms"
        : state.lastError
          ? state.lastError
          : labels.checking;
  }

  function setStatus(next, extra = {}) {
    const prev = state.status;
    Object.assign(state, extra);
    state.status = next;
    if (prev !== next) {
      const line =
        next === "online"
          ? `${iso()} server reachable (${state.latencyMs}ms${state.slow ? ", slow" : ""})`
          : next === "offline"
            ? `${iso()} server unreachable${state.lastError ? " - " + state.lastError : ""}`
            : `${iso()} checking`;
      console.log(`[netMonitor] ${line}`);
      // Mirror the transition into userData/logs/network.log: ping latency
      // rising and falling is the trail that explains an intermittent login.
      if (typeof logEvent === "function") logEvent("netMonitor", line);
    }
    render();
  }

  async function check() {
    if (stopped || checking) return;
    checking = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const started = Date.now();
      const res = await fetch(`${apiBase}/ping`, {
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const latencyMs = Date.now() - started;
      setStatus("online", {
        latencyMs,
        slow: latencyMs >= slowMs,
        consecutiveFailures: 0,
        lastCheckedAt: iso(),
        lastError: null,
      });
    } catch (err) {
      clearTimeout(timeout);
      const message =
        err && err.name === "AbortError"
          ? "timeout"
          : err && err.message
            ? err.message
            : String(err);
      const failures = state.consecutiveFailures + 1;
      // Keep the previous verdict until the failures add up: a single slow or
      // dropped probe must not turn a working connection red.
      const nextStatus =
        failures >= offlineAfterFailures
          ? "offline"
          : state.status === "unknown"
            ? "unknown"
            : state.status;
      setStatus(nextStatus, {
        consecutiveFailures: failures,
        lastCheckedAt: iso(),
        lastError: message,
        slow: false,
      });
    } finally {
      checking = false;
    }
  }

  function start() {
    check();
    timer = setInterval(check, intervalMs);
  }

  function onOnline() {
    if (!stopped) check();
  }
  function onOffline() {
    // The operating system says there is no network at all: that IS a confident
    // outage, so the login phase may say "no connection" right away.
    if (!stopped) {
      setStatus("offline", {
        consecutiveFailures: Math.max(state.consecutiveFailures, offlineAfterFailures),
        slow: false,
        lastCheckedAt: iso(),
        lastError: "the operating system reports no network",
      });
    }
  }
  function onVisorChange() {
    if (!stopped && document.visibilityState === "visible") check();
  }

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisorChange);

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisorChange);
  }

  start();

  return { stop, getState: () => ({ ...state }), check };
}