"use strict";

// Pure, DOM-free helpers for the worker-presence board. Kept in a separate
// classic <script> so the same code runs in the browser and in the Node test
// harness (Test/presence.test.cjs).

// A worker is "afk" once no user activity (mouse, keyboard, touch, wheel) has
// been seen for this long.
const PRESENCE_AFK_AFTER_MS = 5 * 60 * 1000;

/**
 * Presence status for a worker.
 *
 * The worker is "online" (green, on the PC) or "working" (orange, busy on the
 * insurance form) while user activity is recent, and "afk" (red) once they
 * have been idle longer than PRESENCE_AFK_AFTER_MS.
 *
 * @param {"online"|"working"} baseStatus  "working" while the insurance form is
 *   open, otherwise "online".
 * @param {number} lastActivityAt  Epoch ms of the last user interaction.
 * @param {number} [now]           Current time (defaults to Date.now()).
 * @returns {"online"|"working"|"afk"}
 */
function presenceStatusFor(baseStatus, lastActivityAt, now = Date.now()) {
  if (now - lastActivityAt > PRESENCE_AFK_AFTER_MS) return "afk";
  return baseStatus === "working" ? "working" : "online";
}

/**
 * Attach global activity listeners so `onActivity` fires on any user input.
 * Pages call this with a callback that stamps the last-activity timestamp;
 * it is deliberately cheap because it runs on every mouse move.
 */
function trackUserActivity(onActivity) {
  const events = [
    "mousemove",
    "mousedown",
    "keydown",
    "wheel",
    "touchstart",
    "pointerdown",
  ];
  for (const name of events) {
    window.addEventListener(name, onActivity, {
      passive: true,
      capture: true,
    });
  }
}
