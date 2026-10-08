"use strict";
// Durable outbox for requests that must reach the server even when the
// internet connection is slow, unstable or gone.
//
// Lives in the MAIN process on purpose: pages are swapped with
// win.loadFile(), which destroys the renderer (and any timer in it) every time
// the worker moves on to the next policy. Here the retry loop keeps running
// across page changes, and the queue is persisted to disk so it also survives
// an app restart or crash.
//
// Lifecycle of one queued request:
//   1. enqueue(): the body (form data + base64 files) is written to disk
//      BEFORE the first attempt, so nothing is lost even if the app dies.
//   2. Attempts run one at a time, oldest first. A network error, timeout,
//      5xx or a non-API answer (CDN / proxy error page) is transient: the
//      queue pauses and retries every `retryIntervalMs` (5 s) until it lands.
//   3. Once a request may have reached the server (it was sent but no answer
//      came back), every later attempt first asks the server whether the
//      record already exists (`verify`) and only re-sends when it does not.
//      This prevents duplicate policies - and double cash movements - on
//      links where the request arrives but the response is lost.
//
// No Electron dependency (fetch, folder and callbacks are injected), so the
// module can be tested with plain Node (see Test/outbox.test.cjs).

import fs from "fs";
import path from "path";
import crypto from "crypto";

export const DEFAULT_RETRY_INTERVAL_MS = 5000;

// Item statuses:
//   pending - waiting for the next attempt
//   sending - an attempt is in flight
//   auth    - the server answered 401; waits for a fresh token of the same user
//   failed  - the server rejected the request (validation, duplicate, ...);
//             kept until the worker retries or discards it
//   sent    - delivered; kept only until the renderer has completed the
//             linked email (items with a messageId), then removed
const STATUSES = new Set(["pending", "sending", "auth", "failed", "sent"]);
const UNSENT_STATUSES = new Set(["pending", "sending", "auth"]);

// Delivered email items whose email was never completed are dropped after
// this long, so a missed "complete" can never pin an entry forever.
const SENT_RETENTION_MS = 24 * 60 * 60 * 1000;

class TransientError extends Error {}
class AuthError extends Error {}

// Compare a database value with the value that was submitted. Numbers may come
// back as numbers ("0123" vs 123), so numeric strings are compared as numbers.
export function sameValue(a, b) {
  const x = String(a ?? "").trim();
  const y = String(b ?? "").trim();
  if (x === y) return true;
  if (x === "" || y === "") return false;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
}

async function removeFile(file) {
  try {
    await fs.promises.unlink(file);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

// Write via a temp file + rename so a crash mid-write never leaves a
// truncated JSON file behind. On Windows the rename can fail while an
// antivirus/indexer briefly holds the target; fall back to a direct write.
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, data, "utf8");
  try {
    await fs.promises.rename(tmp, file);
  } catch {
    await fs.promises.writeFile(file, data, "utf8");
    await removeFile(tmp).catch(() => {});
  }
}

class PermanentError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || null;
  }
}

// Turn a raw HTTP answer into { status, isJson, data }.
function parseAnswer(status, raw) {
  let data = {};
  let isJson = false;
  if (raw) {
    try {
      data = JSON.parse(raw);
      isJson = data !== null && typeof data === "object";
      if (!isJson) data = {};
    } catch {
      data = {};
    }
  }
  return { status, isJson, data };
}

// Chromium network errors that are raised BEFORE any byte of the request
// left this machine. Only these prove that a mutating request did not reach
// the server; everything else (timeouts, resets mid-upload, ...) is ambiguous.
const NOT_SENT_ERRORS = [
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_REFUSED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
];

function errorText(err) {
  const parts = [];
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.code) parts.push(String(e.code));
    if (e.message) parts.push(String(e.message));
  }
  return parts.join(" ");
}

function definitelyNotSent(err) {
  const text = errorText(err);
  return NOT_SENT_ERRORS.some((code) => text.includes(code));
}

function describeNetworkError(err) {
  if (err && err.timedOut) return err.message;
  const text = errorText(err);
  return text ? `Network error: ${text}` : "Network error";
}

const SAFE_ID = /^[a-z0-9-]+$/;

export class Outbox {
  /**
   * @param {object}   opts
   * @param {string}   opts.dir      Folder holding the queued requests.
   * @param {Function} opts.fetch    fetch implementation (Electron net.fetch).
   * @param {Function} [opts.onChange] Called with getState() on every change.
   * @param {number}   [opts.retryIntervalMs] Delay between retries (5 s).
   */
  constructor(opts = {}) {
    if (!opts.dir) throw new Error("Outbox: dir is required");
    if (typeof opts.fetch !== "function") {
      throw new Error("Outbox: fetch is required");
    }
    this.dir = opts.dir;
    this.fetch = opts.fetch;
    // API origin, e.g. "https://example.com" (no trailing slash).
    this.baseUrl = String(opts.baseUrl || "").replace(/\/+$/, "");
    this.onChange = opts.onChange || (() => {});
    this.onDelivered = opts.onDelivered || (() => {});
    this.log = opts.log || console;
    this.retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    // Per-attempt timeout: a fixed part plus the time the body needs at the
    // slowest upload speed we still want to support, so a large attachment on
    // a slow link is not aborted (and restarted) forever.
    this.baseTimeoutMs = opts.baseTimeoutMs ?? 30000;
    this.minBytesPerSecond = opts.minBytesPerSecond ?? 16 * 1024;
    this.maxTimeoutMs = opts.maxTimeoutMs ?? 10 * 60 * 1000;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 20000;

    this.items = [];
    this.seq = 0;
    this.timer = null;
    this.nextRetryAt = null;
    this.running = null;
    this.kickAgain = false;
    this.stopped = false;
    this.lastError = "";
    // null = unknown, true = the last request reached the API, false = not.
    this.connected = null;
    // Items a submit() call is currently waiting on: id -> Set<resolve>.
    this.waiters = new Map();
  }

  metaFile(id) {
    return path.join(this.dir, `${id}.meta.json`);
  }
  bodyFile(id) {
    return path.join(this.dir, `${id}.body.json`);
  }

  // Load the queue saved by a previous run.
  async init() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const names = await fs.promises.readdir(this.dir);
    const metaIds = new Set();
    for (const name of names) {
      if (name.endsWith(".tmp")) {
        await removeFile(path.join(this.dir, name)).catch(() => {});
        continue;
      }
      if (!name.endsWith(".meta.json")) continue;
      const id = name.slice(0, -".meta.json".length);
      try {
        const meta = JSON.parse(
          await fs.promises.readFile(path.join(this.dir, name), "utf8")
        );
        if (!meta || meta.id !== id || !STATUSES.has(meta.status)) {
          throw new Error("invalid entry");
        }
        // The app quit or crashed while this request was in flight: it may
        // have reached the server, so check before sending it again.
        if (meta.status === "sending") {
          meta.status = "pending";
          meta.maybeDelivered = true;
        }
        if (
          meta.status === "sent" &&
          Date.now() - (meta.sentAt || 0) > SENT_RETENTION_MS
        ) {
          await this.removeFiles(id);
          continue;
        }
        metaIds.add(id);
        this.items.push(meta);
        this.seq = Math.max(this.seq, Number(meta.seq) || 0);
      } catch (err) {
        this.log.error(`[Outbox] Skipping unreadable entry ${name}:`, err);
      }
    }
    // Drop body files whose metadata is gone (crash between the two writes).
    for (const name of names) {
      if (!name.endsWith(".body.json")) continue;
      const id = name.slice(0, -".body.json".length);
      if (!metaIds.has(id)) {
        await removeFile(path.join(this.dir, name)).catch(() => {});
      }
    }
    this.sortItems();
    this.emit();
    this.kick();
  }

  sortItems() {
    this.items.sort(
      (a, b) => a.createdAt - b.createdAt || (a.seq || 0) - (b.seq || 0)
    );
  }

  /**
   * Persist a request and start delivering it.
   *
   * @param {object} req
   * @param {string} req.path      API path, e.g. "/worker/insurances".
   * @param {string} [req.method]  Defaults to POST.
   * @param {string} req.body      Serialized JSON body.
   * @param {string} req.token     Bearer token of the submitting user.
   * @param {string} [req.username]
   * @param {string} [req.label]   Short human label shown in the UI.
   * @param {string} [req.messageId] Linked unread email (email policies).
   * @param {object} [req.verify]  How to check whether an attempt that got
   *   no answer already reached the server:
   *   { path, listKey, match: { Column: value, ... } }.
   * @returns {Promise<object>} The public view of the new item.
   */
  async enqueue(req = {}) {
    if (!req.path || typeof req.path !== "string" || !req.path.startsWith("/")) {
      throw new Error("Outbox: a relative API path is required");
    }
    if (typeof req.body !== "string") {
      throw new Error("Outbox: body must be a serialized string");
    }
    const id = crypto.randomUUID();
    const meta = {
      id,
      seq: ++this.seq,
      method: String(req.method || "POST").toUpperCase(),
      baseUrl: req.baseUrl ? String(req.baseUrl) : "",
      path: req.path,
      token: String(req.token || ""),
      username: String(req.username || ""),
      label: String(req.label || ""),
      kind: String(req.kind || ""),
      messageId: req.messageId ? String(req.messageId) : null,
      verify: req.verify || null,
      size: Buffer.byteLength(req.body, "utf8"),
      createdAt: Date.now(),
      status: "pending",
      attempts: 0,
      lastError: "",
      lastAttemptAt: null,
      maybeDelivered: false,
      sentAt: null,
      result: null,
    };
    // Body first, metadata second: an entry only exists once both are on disk.
    await writeAtomic(this.bodyFile(id), req.body);
    await this.saveMeta(meta);
    this.items.push(meta);
    this.sortItems();
    this.emit();
    this.kick(true);
    return this.publicItem(meta);
  }

  /**
   * Enqueue and wait up to `waitMs` for the first outcome, so the caller can
   * behave like a normal request while the connection is fine. Resolves early
   * as soon as delivery fails transiently: there is no point in keeping the
   * worker waiting while the network is down.
   *
   * @returns {Promise<{id, status, result, error, queued}>}
   */
  async submit(req, waitMs = 8000) {
    const item = await this.enqueue(req);
    return this.waitFor(item.id, waitMs);
  }

  waitFor(id, waitMs) {
    const meta = this.find(id);
    if (!meta) return Promise.resolve({ id, status: "gone", queued: false });
    const settled = this.outcomeOf(meta, true);
    if (settled) return Promise.resolve(settled);
    return new Promise((resolve) => {
      let done = false;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const set = this.waiters.get(id);
        if (set) {
          set.delete(finish);
          if (!set.size) this.waiters.delete(id);
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        const current = this.find(id);
        finish(
          current
            ? this.outcomeOf(current, false) || {
                id,
                status: current.status,
                queued: true,
                error: current.lastError,
              }
            : { id, status: "gone", queued: false }
        );
      }, Math.max(0, waitMs));
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      this.waiters.get(id).add(finish);
    });
  }

  // The outcome a waiting submit() should return now, or null to keep waiting.
  outcomeOf(meta, initial) {
    if (meta.status === "sent") {
      return { id: meta.id, status: "sent", queued: false, result: meta.result };
    }
    if (meta.status === "failed") {
      return {
        id: meta.id,
        status: "failed",
        queued: false,
        error: meta.lastError,
        httpStatus: meta.httpStatus || null,
      };
    }
    if (meta.status === "auth") {
      return { id: meta.id, status: "auth", queued: true, error: meta.lastError };
    }
    if (!initial && meta.status === "pending" && meta.attempts > 0) {
      return { id: meta.id, status: "pending", queued: true, error: meta.lastError };
    }
    return null;
  }

  notifyWaiters(meta) {
    const set = this.waiters.get(meta.id);
    if (!set) return;
    const outcome = this.outcomeOf(meta, false);
    if (!outcome) return;
    for (const finish of Array.from(set)) finish(outcome);
  }

  find(id) {
    return this.items.find((m) => m.id === id) || null;
  }

  // What the renderer sees. The token and the body never leave this module.
  publicItem(meta) {
    return {
      id: meta.id,
      label: meta.label,
      kind: meta.kind,
      username: meta.username,
      messageId: meta.messageId,
      status: meta.status,
      attempts: meta.attempts,
      lastError: meta.lastError,
      lastAttemptAt: meta.lastAttemptAt,
      createdAt: meta.createdAt,
      sentAt: meta.sentAt,
      size: meta.size,
      result: meta.result,
    };
  }

  unsentCount() {
    return this.items.filter((m) => UNSENT_STATUSES.has(m.status)).length;
  }

  getState() {
    return {
      items: this.items.map((m) => this.publicItem(m)),
      unsentCount: this.unsentCount(),
      failedCount: this.items.filter((m) => m.status === "failed").length,
      nextRetryAt: this.nextRetryAt,
      connected: this.connected,
      lastError: this.lastError,
      retryIntervalMs: this.retryIntervalMs,
    };
  }

  emit() {
    try {
      this.onChange(this.getState());
    } catch (err) {
      this.log.error("[Outbox] onChange handler failed:", err);
    }
  }

  async saveMeta(meta) {
    await writeAtomic(this.metaFile(meta.id), JSON.stringify(meta));
  }

  async removeFiles(id) {
    await removeFile(this.metaFile(id));
    await removeFile(this.bodyFile(id));
  }

  // Persist + publish a status change. A failed disk write is logged but
  // never stops delivery: the in-memory queue stays authoritative.
  async update(meta, changes) {
    Object.assign(meta, changes);
    try {
      await this.saveMeta(meta);
    } catch (err) {
      this.log.error(`[Outbox] Failed to persist ${meta.id}:`, err);
    }
    this.notifyWaiters(meta);
    this.emit();
  }

  async drop(meta) {
    this.items = this.items.filter((m) => m !== meta);
    try {
      await this.removeFiles(meta.id);
    } catch (err) {
      this.log.error(`[Outbox] Failed to delete ${meta.id}:`, err);
    }
    this.emit();
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  // One HTTP exchange with a hard deadline covering BOTH the upload and the
  // response body. Any failure here means "no usable answer": the caller
  // decides whether the request may still have reached the server.
  async request(meta, init, timeoutMs, mutating) {
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        const err = new Error(
          `No answer from the server within ${Math.round(timeoutMs / 1000)} s`
        );
        err.timedOut = true;
        reject(err);
      }, timeoutMs);
    });
    timeout.catch(() => {});
    try {
      const base = String(meta.baseUrl || this.baseUrl).replace(/\/+$/, "");
      const url = `${base}${init.path || meta.path}`;
      const res = await Promise.race([
        this.fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
          cache: "no-store",
        }),
        timeout,
      ]);
      const raw = await Promise.race([res.text(), timeout]);
      return parseAnswer(res.status, raw);
    } catch (err) {
      const e = new TransientError(describeNetworkError(err));
      e.network = true;
      e.maybeDelivered = mutating && !definitelyNotSent(err);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Classify a non-2xx answer. Throws the matching error type.
  rejectAnswer(answer, mutating) {
    const { status, isJson, data } = answer;
    const apiError = isJson && typeof data.error === "string" ? data.error : "";
    if (status === 413) {
      throw new PermanentError(
        "The request is too large for the server (attachments too big)",
        status
      );
    }
    if (status === 401 && isJson) {
      throw new AuthError(apiError || "Session expired - log in again");
    }
    // Not produced by the API (CDN / firewall / proxy / captive portal page),
    // or a temporary server-side condition: retry.
    if (!isJson || status === 408 || status === 429 || status >= 500) {
      const e = new TransientError(
        isJson
          ? apiError || `Server error (HTTP ${status})`
          : `The server could not be reached (HTTP ${status} from an intermediary)`
      );
      // An intermediary that is not answering for the API at all behaves like
      // a network outage: pause the whole queue instead of trying every item.
      e.network = !isJson;
      // A gateway timeout / 5xx may come AFTER the API already processed the
      // request, so the next attempt must check before re-sending.
      e.maybeDelivered = mutating && (status >= 500 || status === 408);
      throw e;
    }
    throw new PermanentError(apiError || `Request failed (HTTP ${status})`, status);
  }

  async send(meta) {
    let body;
    try {
      body = await fs.promises.readFile(this.bodyFile(meta.id), "utf8");
    } catch (err) {
      throw new PermanentError(
        `The saved request data could not be read (${err.code || err.message})`
      );
    }
    const timeoutMs = Math.min(
      this.maxTimeoutMs,
      this.baseTimeoutMs +
        Math.ceil(((meta.size || 0) / this.minBytesPerSecond) * 1000)
    );
    const answer = await this.request(
      meta,
      {
        method: meta.method,
        headers: {
          Authorization: `Bearer ${meta.token}`,
          "Content-Type": "application/json",
        },
        body,
      },
      timeoutMs,
      true
    );
    if (answer.status >= 200 && answer.status < 300) {
      // Our API always answers JSON. A 2xx HTML page is a captive portal
      // (hotel / mobile hotspot login) or proxy page, not a delivery.
      if (!answer.isJson) {
        const e = new TransientError(
          `Unexpected non-API answer (HTTP ${answer.status}) - captive portal or proxy`
        );
        e.network = true;
        e.maybeDelivered = true;
        throw e;
      }
      return answer.data;
    }
    this.rejectAnswer(answer, true);
  }

  /**
   * After an attempt that may have reached the server, ask the server whether
   * the record exists. Returns true (already delivered), false (not there,
   * safe to send) or null (cannot be checked - send and rely on the server's
   * own duplicate check). Throws when the check itself cannot run now.
   */
  async verifyDelivered(meta) {
    const v = meta.verify;
    if (!v || !v.path || !v.match) return null;
    const answer = await this.request(
      meta,
      {
        path: v.path,
        method: "GET",
        headers: { Authorization: `Bearer ${meta.token}` },
      },
      this.verifyTimeoutMs,
      false
    );
    if (answer.status < 200 || answer.status >= 300 || !answer.isJson) {
      try {
        this.rejectAnswer(answer, false);
      } catch (err) {
        if (err instanceof PermanentError) {
          this.log.warn(
            `[Outbox] Delivery check for ${meta.id} is not possible (${err.message}); re-sending`
          );
          return null;
        }
        throw err;
      }
      return null;
    }
    const data = answer.data;
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data[v.listKey])
      ? data[v.listKey]
      : [];
    return list.some(
      (row) =>
        row &&
        Object.entries(v.match).every(([key, value]) =>
          sameValue(row[key], value)
        )
    );
  }

  // -------------------------------------------------------------------------
  // Delivery loop
  // -------------------------------------------------------------------------

  // Start a delivery pass now (or right after the running one). `immediate`
  // also cancels the pending 5 s wait, e.g. after a new submit or on resume.
  kick(immediate = true) {
    if (this.stopped) return;
    if (this.running) {
      this.kickAgain = true;
      return;
    }
    if (!immediate && this.timer) return;
    this.clearTimer();
    this.running = this.runPass()
      .catch((err) => this.log.error("[Outbox] Delivery pass failed:", err))
      .finally(() => {
        this.running = null;
        if (this.kickAgain && !this.stopped) {
          this.kickAgain = false;
          this.kick(true);
        }
      });
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRetryAt = null;
  }

  scheduleRetry() {
    if (this.stopped) return;
    this.clearTimer();
    this.nextRetryAt = Date.now() + this.retryIntervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRetryAt = null;
      this.kick(true);
    }, this.retryIntervalMs);
    this.emit();
  }

  // Deliver pending items oldest first. Stops at the first network-level
  // failure (the rest would fail the same way) and schedules a retry.
  async runPass() {
    let needRetry = false;
    for (const meta of [...this.items]) {
      if (this.stopped) return;
      if (!this.items.includes(meta) || meta.status !== "pending") continue;
      const outcome = await this.attempt(meta);
      if (outcome === "network") {
        needRetry = true;
        break;
      }
      if (outcome === "retry") needRetry = true;
    }
    this.pruneSent();
    if (needRetry) this.scheduleRetry();
    else this.emit();
  }

  /** @returns {Promise<"sent"|"failed"|"auth"|"retry"|"network">} */
  async attempt(meta) {
    await this.update(meta, {
      status: "sending",
      attempts: meta.attempts + 1,
      lastAttemptAt: Date.now(),
    });
    // Result of the delivery check of THIS attempt (undefined = not run).
    let verified;
    try {
      let delivered = false;
      if (meta.maybeDelivered) {
        const exists = await this.verifyDelivered(meta);
        verified = exists;
        if (exists === true) {
          delivered = true;
          this.log.warn(
            `[Outbox] ${meta.label || meta.id} already reached the server on an earlier attempt; not re-sending`
          );
        }
      }
      const result = delivered ? { alreadyDelivered: true } : await this.send(meta);
      this.connected = true;
      this.lastError = "";
      await this.markSent(meta, result);
      return "sent";
    } catch (err) {
      return this.handleAttemptError(meta, err, verified);
    }
  }

  async handleAttemptError(meta, err, verified) {
    if (err instanceof AuthError) {
      this.connected = true;
      this.log.warn(`[Outbox] ${meta.label || meta.id}: ${err.message}`);
      await this.update(meta, { status: "auth", lastError: err.message });
      return "auth";
    }
    if (err instanceof PermanentError) {
      this.connected = true;
      // A 409 after an attempt that may have landed usually means OUR earlier
      // attempt created the record. Only when the delivery check could not
      // run, though: if it ran and found no matching record of this author,
      // the number really belongs to somebody else - a genuine conflict.
      if (err.status === 409 && meta.maybeDelivered && verified !== false) {
        this.log.warn(
          `[Outbox] ${meta.label || meta.id}: duplicate after an unanswered attempt - treating as delivered`
        );
        await this.markSent(meta, { alreadyDelivered: true });
        return "sent";
      }
      this.log.error(`[Outbox] ${meta.label || meta.id} rejected: ${err.message}`);
      // The worker is still on the form, waiting for this answer: the form
      // shows the error and keeps the data, so a queued copy would only be a
      // stale duplicate. Hand the outcome over and forget the item.
      if (this.waiters.has(meta.id)) {
        Object.assign(meta, {
          status: "failed",
          lastError: err.message,
          httpStatus: err.status,
        });
        await this.drop(meta);
        this.notifyWaiters(meta);
        return "failed";
      }
      await this.update(meta, {
        status: "failed",
        lastError: err.message,
        httpStatus: err.status,
      });
      return "failed";
    }
    // Transient: keep it queued and retry.
    const message = err && err.message ? err.message : String(err);
    this.lastError = message;
    if (err && err.network) this.connected = false;
    this.log.warn(
      `[Outbox] ${meta.label || meta.id}: attempt ${meta.attempts} failed (${message}); retrying in ${Math.round(this.retryIntervalMs / 1000)} s`
    );
    await this.update(meta, {
      status: "pending",
      lastError: message,
      maybeDelivered: meta.maybeDelivered || Boolean(err && err.maybeDelivered),
    });
    return err && err.network ? "network" : "retry";
  }

  async markSent(meta, result) {
    const safeResult =
      result && typeof result === "object" ? JSON.parse(JSON.stringify(result)) : null;
    // Tell the UI when a request that was QUEUED (nobody is waiting on it any
    // more) finally lands, so the worker learns about it - and about a return
    // email that failed after the policy was saved.
    const waitedOn = this.waiters.has(meta.id);
    if (!waitedOn) {
      try {
        this.onDelivered(this.publicItem(meta), safeResult);
      } catch (err) {
        this.log.error("[Outbox] onDelivered handler failed:", err);
      }
    }
    if (meta.messageId) {
      // Kept (without its body) until the renderer completes the linked email.
      await this.update(meta, {
        status: "sent",
        sentAt: Date.now(),
        lastError: "",
        result: safeResult,
      });
      await removeFile(this.bodyFile(meta.id)).catch(() => {});
    } else {
      meta.status = "sent";
      meta.result = safeResult;
      // Remove from disk BEFORE resolving the caller, so "sent" always means
      // the local copy is gone (no window where a restart could re-send it).
      await this.drop(meta);
      this.notifyWaiters(meta);
    }
  }

  pruneSent() {
    const now = Date.now();
    for (const meta of [...this.items]) {
      if (meta.status === "sent" && now - (meta.sentAt || 0) > SENT_RETENTION_MS) {
        this.drop(meta);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Controls used by the UI
  // -------------------------------------------------------------------------

  // Try every waiting item right now (manual "Retry now", wake from sleep,
  // network back online). Failed items are only retried when `includeFailed`.
  async retryAll(includeFailed = false) {
    for (const meta of this.items) {
      if (includeFailed && meta.status === "failed") {
        await this.update(meta, { status: "pending", lastError: "" });
      }
    }
    this.kick(true);
    return this.getState();
  }

  async retry(id) {
    if (typeof id !== "string" || !SAFE_ID.test(id)) return this.getState();
    const meta = this.find(id);
    if (meta && (meta.status === "failed" || meta.status === "pending")) {
      await this.update(meta, { status: "pending", lastError: "" });
      this.kick(true);
    }
    return this.getState();
  }

  // Remove an item the worker gave up on. An item that is being sent right
  // now cannot be discarded (it may be landing on the server this moment).
  async discard(id) {
    if (typeof id !== "string" || !SAFE_ID.test(id)) return false;
    const meta = this.find(id);
    if (!meta || meta.status === "sending") return false;
    await this.drop(meta);
    return true;
  }

  // The user logged in again: hand the fresh token to every queued request of
  // the same user (including those parked on a 401) and resume delivery.
  // Requests of a different user keep their own token and wait for theirs.
  async updateToken(username, token) {
    if (!token) return this.getState();
    let changed = false;
    for (const meta of this.items) {
      if (meta.username !== String(username || "")) continue;
      if (!UNSENT_STATUSES.has(meta.status)) continue;
      // Same token that was already rejected: nothing to gain from a retry.
      if (meta.token === String(token)) continue;
      const changes = { token: String(token) };
      if (meta.status === "auth") changes.status = "pending";
      await this.update(meta, changes);
      changed = true;
    }
    if (changed) this.kick(true);
    return this.getState();
  }

  // The renderer finished the follow-up of a delivered email policy
  // (complete_email was sent): forget the item for good.
  async acknowledge(id) {
    if (typeof id !== "string" || !SAFE_ID.test(id)) return false;
    const meta = this.find(id);
    if (!meta || meta.status !== "sent") return false;
    await this.drop(meta);
    return true;
  }

  stop() {
    this.stopped = true;
    this.clearTimer();
  }
}
