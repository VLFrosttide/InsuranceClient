"use strict";

// Pure helpers for the email-attachment download UI.
//
// Attachment bytes arrive over the WebSocket as ONE base64 message - there is
// no byte-level stream we could measure. The progress bar therefore advances
// from an estimate: how long the bytes would need at a deliberately
// conservative throughput, capped at 90% until the reply actually arrives (at
// which point the bar goes to 100%). That still gives the worker clear,
// moving feedback instead of a frozen thumbnail, and it never claims a file is
// finished before its bytes are really here.
//
// When the server did not send a size there is nothing to estimate, so the
// UI shows an indeterminate (animated) bar instead: `null` means "unknown".
//
// Kept DOM-free so the same code runs in the browser and in the Node test
// harness (Test/attachmentProgress.test.cjs).

// Throughput used for the estimate. A 1 MB photo takes ~5 s to reach 90%,
// which matches what a worker sees on a typical branch connection; a genuinely
// slow link simply sits at 90% a little longer.
const ATTACHMENT_ASSUMED_BYTES_PER_SEC = 256 * 1024;

// base64 inflates the payload by roughly 4/3, plus JSON overhead.
const ATTACHMENT_BASE64_OVERHEAD = 1.37;

// Never estimate a transfer shorter than this, so tiny files still show a
// readable bar instead of jumping to 90% in one frame.
const ATTACHMENT_PROGRESS_MIN_MS = 800;

// The bar stops here until the bytes have actually arrived.
const ATTACHMENT_PROGRESS_MAX_WHILE_WAITING = 90;

/**
 * Estimated download progress for one attachment.
 *
 * @param {number|string|null|undefined} size      Attachment size in bytes.
 * @param {number} elapsedMs                        Time since the request was sent.
 * @param {boolean} [done]                          Bytes have arrived.
 * @returns {number|null} 0-90 while waiting, 100 when done, or null when the
 *   size is unknown (render an indeterminate bar).
 */
function attachmentProgressPercent(size, elapsedMs, done = false) {
  if (done) return 100;

  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;

  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;

  const expectedMs = Math.max(
    ATTACHMENT_PROGRESS_MIN_MS,
    (bytes * ATTACHMENT_BASE64_OVERHEAD * 1000) /
      ATTACHMENT_ASSUMED_BYTES_PER_SEC
  );
  const percent = Math.round(
    (elapsed / expectedMs) * ATTACHMENT_PROGRESS_MAX_WHILE_WAITING
  );
  return Math.max(
    0,
    Math.min(ATTACHMENT_PROGRESS_MAX_WHILE_WAITING, percent)
  );
}
