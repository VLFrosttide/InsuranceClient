"use strict";

// ---------------------------------------------------------------------------
// Client-side failure recorder.
//
// When the API answers 403 (or any 4xx/5xx, or the request never reaches the
// server at all) this module captures everything the PC can see: status, every
// response header, the body of the block page, whether `x-hcdn-request-id` is
// present, the exact timestamp and URL, the redacted request headers, the
// proxy/public-IP environment and retry/burst counters. The first successful
// request after a 403 is captured too, so the two can be compared.
//
// Reports are stored on disk by the main process (userData/diag/pending.jsonl,
// see main.js) so they survive a page change, a crash or an app restart, and
// are uploaded to POST /diag/client as soon as the client can reach the server
// again - after a later successful login if the incident blocked logging in.
//
// Loaded by every page BEFORE common.js so it can wrap window.fetch. The only
// global it exposes is `Diag` (used by the admin Diagnostics tab).
// ---------------------------------------------------------------------------
(function () {
  const QUEUE_KEY = "clientDiagQueue";
  const MAX_QUEUE = 150;
  const MAX_BODY_CHARS = 8 * 1024;
  const MAX_UPLOAD_BATCH = 20;
  const MAX_UPLOAD_BYTES = 400 * 1024;
  const REPEAT_WINDOW_MS = 2 * 60 * 1000;
  const PENDING_PAIR_LIMIT = 5;
  const PENDING_PAIR_TTL_MS = 30 * 60 * 1000;
  const FLUSH_INTERVAL_MS = 60 * 1000;
  const FLUSH_RETRY_BASE_MS = 30 * 1000;
  const FLUSH_RETRY_MAX_MS = 5 * 60 * 1000;
  const ENV_TTL_MS = 10 * 60 * 1000;

  const state = {
    started: false,
    originalFetch: null,
    clientId: "",
    env: null,
    envAt: 0,
    envPromise: null,
    pendingPairs: [],
    attempts: new Map(),
    requestTimes: [],
    lastApiOrigin: "",
    flushing: false,
    flushFailures: 0,
    nextFlushAt: 0,
    blockedUntil: 0,
    flushTimer: null,
    lastFlushAt: null,
    lastFlushError: null,
    lastUploadStored: null,
  };

  // -------------------------------------------------------------------------
  // Generic helpers
  // -------------------------------------------------------------------------
  function nowIso() {
    return new Date().toISOString();
  }

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch {
      // Fall through to the manual form.
    }
    const hex = () => Math.floor(Math.random() * 0x100000000).toString(16);
    return `${hex()}-${hex()}-${hex()}`;
  }

  // Short, non-reversible fingerprint (FNV-1a). Used for tokens so two reports
  // can be compared ("same session?") without storing the secret itself.
  function fingerprint(text) {
    let hash = 0x811c9dc5;
    const value = String(text || "");
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function clip(value, max) {
    if (value === undefined || value === null) return "";
    const text = String(value);
    return text.length > max ? text.slice(0, max) : text;
  }

  function token() {
    try {
      return localStorage.getItem("token") || "";
    } catch {
      return "";
    }
  }

  function ls(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function apiBase() {
    if (typeof API_BASE !== "undefined" && API_BASE) {
      return String(API_BASE).replace(/\/+$/, "");
    }
    return state.lastApiOrigin || "";
  }

  function urlOf(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).href;
      if (input && typeof input.url === "string") {
        return new URL(input.url, location.href).href;
      }
    } catch {
      // Not a URL we can attribute (Request objects from other contexts).
    }
    return "";
  }

  function methodOf(input, init) {
    const method =
      (init && init.method) ||
      (input && typeof input === "object" && input.method) ||
      "GET";
    return String(method).toUpperCase();
  }

  function pathOf(url) {
    try {
      const parsed = new URL(url);
      return parsed.pathname + parsed.search;
    } catch {
      return url;
    }
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof headers.forEach === "function") {
        headers.forEach((value, key) => {
          out[String(key).toLowerCase()] = String(value);
        });
        return out;
      }
      for (const key of Object.keys(headers)) {
        out[String(key).toLowerCase()] = String(headers[key]);
      }
    } catch {
      // An exotic Headers implementation: record nothing rather than throw.
    }
    return out;
  }

  // Never upload the session token or cookies; keep a comparable fingerprint.
  function redactHeaders(headers) {
    const out = headersToObject(headers);
    for (const key of Object.keys(out)) {
      if (
        /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/.test(
          key
        )
      ) {
        const value = out[key];
        out[key] = `[redacted len=${value.length} fp=${fingerprint(value)}]`;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Environment snapshot
  // -------------------------------------------------------------------------
  function rendererContext() {
    const navigatorAny = navigator || {};
    const connection =
      navigatorAny.connection ||
      navigatorAny.mozConnection ||
      navigatorAny.webkitConnection ||
      null;
    let screenInfo = null;
    try {
      screenInfo = {
        width: window.screen && window.screen.width,
        height: window.screen && window.screen.height,
        availWidth: window.screen && window.screen.availWidth,
        availHeight: window.screen && window.screen.availHeight,
        colorDepth: window.screen && window.screen.colorDepth,
        devicePixelRatio: window.devicePixelRatio,
      };
    } catch {
      screenInfo = null;
    }
    return {
      page: clip(location.pathname, 300),
      href: clip(location.href, 1500),
      origin: clip(location.origin, 300),
      referrer: clip(document.referrer, 500),
      title: clip(document.title, 200),
      visibility: document.visibilityState,
      userAgent: clip(navigatorAny.userAgent, 500),
      platform: clip(navigatorAny.platform, 100),
      language: clip(navigatorAny.language, 40),
      languages: Array.isArray(navigatorAny.languages)
        ? navigatorAny.languages.slice(0, 8)
        : null,
      online:
        typeof navigatorAny.onLine === "boolean" ? navigatorAny.onLine : null,
      timezone: (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          return null;
        }
      })(),
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      localTime: new Date().toString(),
      screen: screenInfo,
      hardwareConcurrency: navigatorAny.hardwareConcurrency || null,
      deviceMemory: navigatorAny.deviceMemory || null,
      connection: connection
        ? {
            effectiveType: connection.effectiveType || null,
            downlink: connection.downlink ?? null,
            rtt: connection.rtt ?? null,
            saveData: connection.saveData ?? null,
          }
        : null,
      username: clip(ls("username"), 45),
      role: clip(ls("role"), 8),
      branch: clip(ls("branch"), 100),
    };
  }

  // Full environment: main-process facts (hostname, OS user, proxy, public IP,
  // TLS issuer, versions) plus the renderer snapshot. Cached for ten minutes so
  // a 403 storm does not perform a public-IP lookup per report.
  async function env(force) {
    if (!force && state.env && Date.now() - state.envAt < ENV_TTL_MS) {
      return state.env;
    }
    if (state.envPromise) return state.envPromise;
    state.envPromise = (async () => {
      let bridgeEnv = null;
      let envError = null;
      try {
        if (window.bridge && typeof window.bridge.DiagContext === "function") {
          bridgeEnv = await window.bridge.DiagContext();
        }
      } catch (err) {
        envError = clip((err && err.message) || err, 300);
      }
      if (bridgeEnv && bridgeEnv.clientId && !state.clientId) {
        state.clientId = String(bridgeEnv.clientId);
      }
      const merged = {
        collectedAt: nowIso(),
        clientId: state.clientId || null,
        ...(bridgeEnv && typeof bridgeEnv === "object" ? bridgeEnv : {}),
        renderer: rendererContext(),
        envError,
      };
      state.env = merged;
      state.envAt = Date.now();
      return merged;
    })();
    try {
      return await state.envPromise;
    } finally {
      state.envPromise = null;
    }
  }

  // -------------------------------------------------------------------------
  // Local queue (main process file, or localStorage when there is no bridge)
  // -------------------------------------------------------------------------
  function readLocalQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeLocalQueue(queue) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
    } catch {
      // Quota exceeded: drop the oldest half and try once more. A diagnostic
      // must never be the reason the application stops working.
      try {
        localStorage.setItem(
          QUEUE_KEY,
          JSON.stringify(queue.slice(-Math.floor(MAX_QUEUE / 2)))
        );
      } catch {
        // Give up quietly.
      }
    }
  }

  async function readQueue() {
    const bridge = window.bridge;
    if (bridge && typeof bridge.DiagRead === "function") {
      try {
        const queue = await bridge.DiagRead();
        if (Array.isArray(queue)) return queue;
      } catch {
        // Fall through to the localStorage copy.
      }
    }
    return readLocalQueue();
  }

  async function writeQueue(queue) {
    const trimmed = queue.slice(-MAX_QUEUE);
    const bridge = window.bridge;
    if (bridge && typeof bridge.DiagSave === "function") {
      try {
        await bridge.DiagSave(trimmed);
        return;
      } catch {
        // Fall through: keep a copy in localStorage instead of losing it.
      }
    }
    writeLocalQueue(trimmed);
  }

  // Queue writes are read-modify-write. Two reports finishing at the same time
  // (e.g. a 403 body and its recovery body) must not overwrite each other, so
  // every mutation runs through this promise chain.
  let queueLock = Promise.resolve();
  function lockQueue(fn) {
    const run = queueLock.then(fn, fn);
    queueLock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // Two identical failures within two minutes are one burst, not two reports:
  // bump the counter (a retry loop is itself diagnostic) and keep the first
  // report's headers/body intact.
  async function enqueue(report) {
    if (!report || !report.url) return;
    return lockQueue(async () => {
      const queue = await readQueue();
      const signature = report.signature;
      if (signature) {
        const now = Date.now();
        for (let i = queue.length - 1; i >= 0; i--) {
          const existing = queue[i];
          if (!existing || existing.signature !== signature) continue;
          const last = Date.parse(
            existing.lastSeenAt || existing.capturedAt || ""
          );
          if (!Number.isFinite(last) || now - last > REPEAT_WINDOW_MS) break;
          existing.repeatCount = (Number(existing.repeatCount) || 1) + 1;
          existing.lastSeenAt = report.capturedAt;
          existing.lastStatus = report.status;
          existing.lastDurationMs = report.durationMs;
          existing.attempt = report.attempt;
          await writeQueue(queue);
          return;
        }
      }
      queue.push(report);
      await writeQueue(queue);
      scheduleFlush(3000);
    });
  }

  // -------------------------------------------------------------------------
  // Retry / burst counters and response-body capture
  // -------------------------------------------------------------------------
  function noteRequestTime() {
    const now = Date.now();
    state.requestTimes.push(now);
    while (state.requestTimes.length && now - state.requestTimes[0] > 60000) {
      state.requestTimes.shift();
    }
    return state.requestTimes.length;
  }

  function nextAttempt(method, path, status) {
    const key = `${method} ${path} ${status}`;
    const attempt = (state.attempts.get(key) || 0) + 1;
    state.attempts.set(key, attempt);
    if (state.attempts.size > 200) {
      // Keep the map from growing forever on a long-lived page.
      state.attempts.delete(state.attempts.keys().next().value);
    }
    return attempt;
  }

  function clearAttempts(method, path) {
    const prefix = `${method} ${path} `;
    for (const key of Array.from(state.attempts.keys())) {
      if (key.startsWith(prefix)) state.attempts.delete(key);
    }
  }

  function isTextual(contentType) {
    const type = String(contentType || "").toLowerCase();
    if (!type) return true;
    return (
      type.includes("text") ||
      type.includes("json") ||
      type.includes("xml") ||
      type.includes("javascript") ||
      type.includes("x-www-form-urlencoded") ||
      type.includes("csv")
    );
  }

  // Reads at most `maxBytes` from a CLONE of the response, so the caller still
  // receives the untouched body. Cancelling the clone's reader stops a large
  // download from being buffered just for diagnostics.
  async function readSnippet(res, maxBytes) {
    const clone = typeof res.clone === "function" ? res.clone() : res;
    if (!clone.body || typeof clone.body.getReader !== "function") {
      const text = await clone.text();
      return { text: text.slice(0, MAX_BODY_CHARS), bytes: text.length };
    }
    const reader = clone.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) break;
      }
      text += decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
    }
    return { text, bytes };
  }

  function titleOf(text) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text || "");
    return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 300) : "";
  }

  function bodyKindOf(contentType, text) {
    const type = String(contentType || "").toLowerCase();
    if (type.includes("json")) return "json";
    if (type.includes("html")) return "html";
    if (type.includes("xml")) return "xml";
    if (type.includes("text/plain")) return "text";
    if (type) return type.split(";")[0].trim() || "other";
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
    if (trimmed.startsWith("<")) return "html";
    return trimmed ? "text" : "empty";
  }

  // -------------------------------------------------------------------------
  // Building one report
  // -------------------------------------------------------------------------
  async function buildReport(opts) {
    const res = opts.res || null;
    const method = opts.method;
    const url = opts.url;
    const path = opts.path || pathOf(url);
    const responseHeaders = res ? headersToObject(res.headers) : {};
    const contentType = responseHeaders["content-type"] || "";
    const status = res ? Number(res.status) || 0 : 0;
    const tokenValue = token();

    let body = "";
    let bodyBytes = 0;
    let bodyTruncated = false;
    if (res) {
      const declared = Number(responseHeaders["content-length"]);
      bodyBytes = Number.isFinite(declared) ? declared : 0;
      if (isTextual(contentType)) {
        try {
          const snippet = await readSnippet(res, MAX_BODY_CHARS * 4);
          body = String(snippet.text || "");
          if (snippet.bytes) bodyBytes = snippet.bytes;
          if (body.length > MAX_BODY_CHARS) {
            bodyTruncated = true;
            body = body.slice(0, MAX_BODY_CHARS);
          }
        } catch {
          body = "";
          bodyTruncated = false;
        }
      }
    }

    const capturedAt = nowIso();
    const capturedAtMs = Date.parse(capturedAt);
    const durationMs =
      typeof opts.durationMs === "number"
        ? Math.round(opts.durationMs)
        : Math.round(performance.now() - opts.startedAt);
    const requestId =
      responseHeaders["x-hcdn-request-id"] ||
      responseHeaders["x-request-id"] ||
      responseHeaders["x-amzn-requestid"] ||
      "";

    return {
      id: uuid(),
      kind: opts.kind,
      capturedAt,
      capturedAtMs,
      status,
      statusText:
        res && res.statusText ? String(res.statusText).slice(0, 100) : "",
      ok: !!(res && res.ok),
      method,
      path,
      url,
      origin: clip(location.origin, 300),
      durationMs,
      attempt: opts.attempt || 1,
      repeatCount: 1,
      requestId: clip(requestId, 80),
      hasHcdnRequestId: !!responseHeaders["x-hcdn-request-id"],
      responseHeaders,
      requestHeaders: redactHeaders(opts.requestHeaders),
      contentType: clip(contentType, 200),
      bodyKind: bodyKindOf(contentType, body),
      bodyTitle: titleOf(body),
      body,
      bodyBytes,
      bodyTruncated,
      errorName: opts.error ? clip(opts.error.name || "Error", 120) : "",
      errorMessage: opts.error
        ? clip((opts.error && opts.error.message) || opts.error, 600)
        : opts.note
          ? clip(opts.note, 600)
          : "",
      pairId: opts.pairId || null,
      samePath:
        opts.samePath === undefined || opts.samePath === null
          ? null
          : !!opts.samePath,
      signature:
        opts.kind === "recovery" ? null : `${method} ${path} ${status}`,
      requestsLastMinute: state.requestTimes.length,
      tokenPresent: !!tokenValue,
      tokenFingerprint: tokenValue ? fingerprint(tokenValue) : "",
      clientId: state.clientId || null,
      env: await env(),
      context: {
        page: clip(location.pathname, 300),
        visibility: document.visibilityState,
        online:
          typeof navigator.onLine === "boolean" ? navigator.onLine : null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Observation of a completed request / a failed connection
  // -------------------------------------------------------------------------
  function pendingPairFor(method, path) {
    const at = Date.now();
    state.pendingPairs = state.pendingPairs.filter(
      (pair) => at - pair.at < PENDING_PAIR_TTL_MS
    );
    const pair = { id: uuid(), method, path, at };
    state.pendingPairs.push(pair);
    while (state.pendingPairs.length > PENDING_PAIR_LIMIT) {
      state.pendingPairs.shift();
    }
    return pair;
  }

  function takePendingPair() {
    const at = Date.now();
    state.pendingPairs = state.pendingPairs.filter(
      (pair) => at - pair.at < PENDING_PAIR_TTL_MS
    );
    return state.pendingPairs.shift() || null;
  }

  function isHtmlSuccess(res, status) {
    if (status < 200 || status >= 300) return false;
    const type = String(
      (res.headers && res.headers.get && res.headers.get("content-type")) || ""
    ).toLowerCase();
    // The app itself never fetches HTML documents; a 200 HTML answer to an API
    // request is a block page served with the wrong status.
    return type.includes("text/html");
  }

  function observeResponse(input, init, res, startedAt) {
    const url = urlOf(input) || (res && res.url ? res.url : "");
    if (!url || !/^https?:/i.test(url)) return;
    const method = methodOf(input, init);
    const path = pathOf(url);
    const status = Number(res.status) || 0;
    noteRequestTime();

    try {
      state.lastApiOrigin = new URL(url).origin;
    } catch {
      // Keep the previous origin.
    }

    if (status >= 400) {
      const attempt = nextAttempt(method, path, status);
      let pair = null;
      if (status === 403) pair = pendingPairFor(method, path);
      buildReport({
        kind: "failure",
        method,
        url,
        path,
        res,
        startedAt,
        attempt,
        requestHeaders: init && init.headers,
        pairId: pair ? pair.id : null,
      })
        .then(enqueue)
        .catch(() => {});
      return;
    }

    if (status >= 300) return;

    clearAttempts(method, path);
    const pair = takePendingPair();
    if (pair) {
      // The first successful request after a 403: kept next to the failure so
      // the admin can compare headers, body and request-id of both.
      buildReport({
        kind: "recovery",
        method,
        url,
        path,
        res,
        startedAt,
        requestHeaders: init && init.headers,
        pairId: pair.id,
        samePath: pair.path === path,
        note: isHtmlSuccess(res, status)
          ? "Successful status with an HTML body (possible block page)"
          : "",
      })
        .then(enqueue)
        .catch(() => {});
      return;
    }

    if (isHtmlSuccess(res, status)) {
      const attempt = nextAttempt(method, path, status);
      buildReport({
        kind: "failure",
        method,
        url,
        path,
        res,
        startedAt,
        attempt,
        requestHeaders: init && init.headers,
        note: "Successful status with an HTML body (possible block page)",
      })
        .then(enqueue)
        .catch(() => {});
      return;
    }

    // A normal successful request is the signal that the server is reachable
    // again: drain everything that was kept during the outage.
    scheduleFlush(1500);
  }

  function observeNetworkError(input, init, err, startedAt) {
    const url = urlOf(input);
    if (!url || !/^https?:/i.test(url)) return;
    const method = methodOf(input, init);
    const path = pathOf(url);
    noteRequestTime();
    const attempt = nextAttempt(method, path, 0);
    buildReport({
      kind: "network-error",
      method,
      url,
      path,
      res: null,
      startedAt,
      attempt,
      error: err,
      requestHeaders: init && init.headers,
    })
      .then(enqueue)
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Uploading
  // -------------------------------------------------------------------------
  function scheduleFlush(delayMs) {
    if (!state.started) return;
    const now = Date.now();
    const requested = now + Math.max(0, Number(delayMs) || 0);
    // A server-imposed backoff (429/401) or a network backoff must not be
    // shortened by an opportunistic "a request succeeded, drain now" call.
    const at = Math.max(
      requested,
      state.blockedUntil > now ? state.blockedUntil : 0,
      state.flushFailures > 0 && state.nextFlushAt > now
        ? state.nextFlushAt
        : 0
    );
    state.nextFlushAt = at;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(
      () => {
        state.flushTimer = null;
        flush(false);
      },
      Math.max(0, at - Date.now())
    );
  }

  function retryDelay() {
    const delay = Math.min(
      FLUSH_RETRY_MAX_MS,
      FLUSH_RETRY_BASE_MS * Math.pow(2, state.flushFailures)
    );
    state.flushFailures += 1;
    return delay;
  }

  async function flush(force) {
    if (!state.started || state.flushing) {
      return { uploaded: 0, pending: null, skipped: "busy" };
    }
    if (!force && state.nextFlushAt && Date.now() < state.nextFlushAt) {
      return { uploaded: 0, pending: null, skipped: "backoff" };
    }

    const queue = await readQueue();
    if (!queue.length) {
      state.nextFlushAt = 0;
      return { uploaded: 0, pending: 0, skipped: "empty" };
    }

    const tokenValue = token();
    const uploadable = queue.filter(
      (report) => report && (!report.tokenPresent || tokenValue)
    );
    if (!uploadable.length) {
      // These reports were captured while signed in; wait for a session.
      state.nextFlushAt = Date.now() + FLUSH_RETRY_MAX_MS;
      return { uploaded: 0, pending: queue.length, skipped: "no-token" };
    }

    const base = apiBase();
    if (!base) {
      state.nextFlushAt = Date.now() + FLUSH_RETRY_MAX_MS;
      return { uploaded: 0, pending: queue.length, skipped: "no-base" };
    }

    const batch = [];
    let bytes = 0;
    for (const report of uploadable) {
      if (batch.length >= MAX_UPLOAD_BATCH) break;
      const size = JSON.stringify(report).length;
      if (batch.length && bytes + size > MAX_UPLOAD_BYTES) break;
      batch.push(report);
      bytes += size;
    }

    const ids = new Set(batch.map((report) => report.id).filter(Boolean));
    const body = {
      clientId:
        state.clientId || (state.env && state.env.clientId) || undefined,
      appVersion:
        state.env && state.env.appVersion ? state.env.appVersion : undefined,
      reports: batch,
      context: { page: clip(location.pathname, 300), uploadedAt: nowIso() },
    };

    state.flushing = true;
    state.lastFlushAt = nowIso();
    try {
      const res = await state.originalFetch(`${base}/diag/client`, {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          tokenValue ? { Authorization: `Bearer ${tokenValue}` } : {}
        ),
        body: JSON.stringify(body),
      });
      const answer = await res.text().catch(() => "");
      if (res.ok) {
        const remainingCount = await lockQueue(async () => {
          const remaining = (await readQueue()).filter(
            (report) => !ids.has(report.id)
          );
          await writeQueue(remaining);
          return remaining.length;
        });
        state.flushFailures = 0;
        state.lastFlushError = null;
        state.lastUploadStored = ids.size;
        state.nextFlushAt = 0;
        state.blockedUntil = 0;
        if (remainingCount) scheduleFlush(2000);
        return { uploaded: ids.size, pending: remainingCount, skipped: null };
      }

      // 429: the server asked us to slow down. 401: the session is gone;
      // wait for the next login instead of hammering the login gate.
      let retryAfter = 0;
      try {
        const parsed = answer ? JSON.parse(answer) : null;
        retryAfter = Number(parsed && parsed.retryAfterSeconds) || 0;
      } catch {
        // Not JSON (a CDN/proxy page): fall back to the standard backoff.
      }
      const delay =
        res.status === 429 && retryAfter
          ? retryAfter * 1000
          : res.status === 401
            ? FLUSH_RETRY_MAX_MS
            : retryDelay();
      state.lastFlushError = `HTTP ${res.status}`;
      state.nextFlushAt = Date.now() + delay;
      if (res.status === 429 || res.status === 401) {
        // Honour the server's own pacing: retries must not shorten this.
        state.blockedUntil = Date.now() + delay;
      }
      scheduleFlush(delay);
      return {
        uploaded: 0,
        pending: queue.length,
        skipped: `http-${res.status}`,
      };
    } catch (err) {
      const delay = retryDelay();
      state.lastFlushError = clip((err && err.message) || String(err), 300);
      state.nextFlushAt = Date.now() + delay;
      scheduleFlush(delay);
      return { uploaded: 0, pending: queue.length, skipped: "network" };
    } finally {
      state.flushing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------
  function install() {
    if (state.started) return;
    state.started = true;

    if (typeof window.fetch === "function") {
      state.originalFetch = window.fetch.bind(window);
      window.fetch = function diagFetch(input, init) {
        const startedAt = performance.now();
        let promise;
        try {
          promise = state.originalFetch(input, init);
        } catch (err) {
          observeNetworkError(input, init, err, startedAt);
          throw err;
        }
        return promise.then(
          (res) => {
            try {
              observeResponse(input, init, res, startedAt);
            } catch {
              // Diagnostics must never break a request.
            }
            return res;
          },
          (err) => {
            try {
              observeNetworkError(input, init, err, startedAt);
            } catch {
              // Same.
            }
            throw err;
          }
        );
      };
    }

    // Collect the environment (and the client id) before the first failure, so
    // the first report already carries the public IP and proxy.
    env().catch(() => {});

    // A client that was blocked earlier flushes its backlog as soon as a page
    // loads, then periodically while reports remain.
    setTimeout(() => {
      scheduleFlush(0);
    }, 4000);
    setInterval(() => {
      if (document.visibilityState === "visible") scheduleFlush(0);
    }, FLUSH_INTERVAL_MS);
    window.addEventListener("online", () => scheduleFlush(1500));
  }

  // WebSocket upgrades cannot be observed through fetch. common.js calls this
  // when a socket errors so a blocked upgrade lands in the same report stream.
  function noteWebSocketFailure(url, detail) {
    const raw = String(url || "");
    const httpUrl = raw.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
    if (!/^https?:/i.test(httpUrl)) return;
    const error = new Error(detail || "WebSocket connection failed");
    error.name = "WebSocketError";
    buildReport({
      kind: "websocket-error",
      method: "GET",
      url: httpUrl,
      path: pathOf(httpUrl),
      res: null,
      startedAt: performance.now(),
      durationMs: 0,
      error,
    })
      .then(enqueue)
      .catch(() => {});
  }

  async function info() {
    const queue = await readQueue();
    return {
      clientId: state.clientId || (state.env && state.env.clientId) || null,
      started: state.started,
      queueLength: queue.length,
      pendingPairs: state.pendingPairs.length,
      lastFlushAt: state.lastFlushAt,
      lastFlushError: state.lastFlushError,
      lastUploadStored: state.lastUploadStored,
      nextFlushAt: state.nextFlushAt
        ? new Date(state.nextFlushAt).toISOString()
        : null,
      env: state.env,
      queue: queue.map((report) => ({
        id: report.id,
        kind: report.kind,
        status: report.status,
        method: report.method,
        path: report.path,
        capturedAt: report.capturedAt,
        repeatCount: report.repeatCount || 1,
        requestId: report.requestId || null,
      })),
    };
  }

  window.Diag = {
    info,
    flush: () => flush(true),
    queue: readQueue,
    environment: () => env(true),
    noteWebSocketFailure,
  };

  install();
})();
