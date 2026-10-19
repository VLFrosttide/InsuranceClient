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
// Usage: startNetMonitor({ apiBase, statusEl, intervalMs, timeoutMs })
// Returns { stop, getState }.

function startNetMonitor(options = {}) {
  const apiBase = String(
    options.apiBase !== undefined
      ? options.apiBase
      : typeof API_BASE !== "undefined"
        ? API_BASE
        : ""
  ).replace(/\/+$/, "");

  const intervalMs = Number(options.intervalMs) || 15000;
  const timeoutMs = Number(options.timeoutMs) || 8000;
  const statusEl = options.statusEl || null;
  const labels = Object.assign(
    { online: "Connected", offline: "Offline", checking: "Checking…" },
    options.labels || {}
  );

  if (!apiBase) {
    console.warn("[netMonitor] No API base configured; network monitor disabled.");
    return { stop: () => {}, getState: () => ({ status: "unknown" }) };
  }

  const state = {
    status: "unknown", // "online" | "offline" | "unknown"
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
        ? "online"
        : state.status === "offline"
          ? "offline"
          : "checking";
    statusEl.textContent = labels[state.status] || labels.checking;
    statusEl.className = "net-status " + cls;
    statusEl.title =
      state.latencyMs != null
        ? "Last check: " + state.latencyMs + " ms"
        : labels.checking;
  }

  function setStatus(next, extra = {}) {
    const prev = state.status;
    Object.assign(state, extra);
    state.status = next;
    if (prev !== next) {
      console.log(
        next === "online"
          ? `[netMonitor] ${iso()} server reachable (${state.latencyMs}ms)`
          : `[netMonitor] ${iso()} server unreachable${state.lastError ? " - " + state.lastError : ""}`
      );
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
      setStatus("offline", {
        consecutiveFailures: state.consecutiveFailures + 1,
        lastCheckedAt: iso(),
        lastError: message,
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
    if (!stopped) setStatus("offline");
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

  return { stop, getState: () => ({ ...state }) };
}