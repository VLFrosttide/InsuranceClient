"use strict";

// Pure, DOM-free helpers for the end-of-shift reminder and the admin's
// "forgotten shift" fix. Kept in a separate classic <script> so the same code
// runs in the browser and in the Node test harness
// (Test/shiftReminder.test.cjs).
//
// The shift day ends at local midnight. The reminder fires five minutes
// before it, so the last chance to press "End shift" (reset the branch's
// current cash / card balance / cash from brokers) is not missed.

const SHIFT_REMINDER_MINUTES_BEFORE_MIDNIGHT = 5;
const SHIFT_REMINDER_LEAD_MS =
  SHIFT_REMINDER_MINUTES_BEFORE_MIDNIGHT * 60 * 1000;

/** Local "YYYY-MM-DD" for a Date (built from local parts, not UTC). */
function shiftLocalDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Milliseconds until the next local midnight. */
function shiftMsUntilMidnight(now = new Date()) {
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0
  );
  return midnight.getTime() - now.getTime();
}

/**
 * True once the five-minute reminder window has opened (23:55-23:59:59).
 * At 00:00 the window closes again for the rest of the new day.
 */
function shiftReminderWindowOpen(now = new Date()) {
  const ms = shiftMsUntilMidnight(now);
  return ms > 0 && ms <= SHIFT_REMINDER_LEAD_MS;
}

/**
 * Milliseconds until the reminder should fire: 0 while the window is already
 * open, otherwise the time left until today's 23:55 (which correctly rolls to
 * tomorrow after midnight).
 */
function shiftMsUntilReminder(now = new Date()) {
  if (shiftReminderWindowOpen(now)) return 0;
  return Math.max(0, shiftMsUntilMidnight(now) - SHIFT_REMINDER_LEAD_MS);
}

/**
 * Milliseconds until the NEXT 23:55 that is still ahead, even when called
 * inside the reminder window. Used to re-arm after a reminder has fired: at
 * 23:55 this returns a full day instead of 0, so it can never fire in a loop.
 */
function shiftMsUntilNextReminder(now = new Date()) {
  const ms = shiftMsUntilMidnight(now);
  if (ms > SHIFT_REMINDER_LEAD_MS) return ms - SHIFT_REMINDER_LEAD_MS;
  const DAY_MS = 24 * 60 * 60 * 1000;
  return ms + DAY_MS - SHIFT_REMINDER_LEAD_MS;
}

/**
 * The day the reminder belongs to (local "YYYY-MM-DD"). Used as the key for
 * "already dismissed", so one dismissal silences today's reminder only.
 */
function shiftReminderDayKey(now = new Date()) {
  return shiftLocalDate(now);
}

/**
 * Whole seconds left in the shift, for the countdown shown in the banner.
 * 0 means "midnight has passed" (or the window is not open), which the banner
 * renders as "please finish last night's shift now".
 */
function shiftReminderSecondsLeft(now = new Date()) {
  if (!shiftReminderWindowOpen(now)) return 0;
  return Math.max(0, Math.floor(shiftMsUntilMidnight(now) / 1000));
}

/** "5:00", "0:59" - the countdown format used in the banner. */
function formatShiftCountdown(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The last representable second of a local day ("YYYY-MM-DD 23:59:59"). This
 * is the "midnight" a shift ends on: the shift of the 13th ends between the
 * 13th and the 14th, and everything created from 14th 00:00:00 belongs to the
 * new day.
 *
 * Returns null for an invalid date.
 */
function shiftEndOfDayTimestamp(dateString) {
  return shiftCloseTimestamp(dateString, "23:59:59");
}

/**
 * Split a branch's cash drawer into the part that belongs to the closed shift
 * and the part that was recorded afterwards (today's cash).
 *
 * `live` is the drawer balance now; `asOf` is the balance at the end of the
 * forgotten day. Their difference is exactly the cash created after midnight
 * (insurances, manual increases and reductions), which must stay in today's
 * drawer.
 *
 * A negative "today" means the drawer now holds less than it did at midnight
 * (today's expenses were paid out of the old shift's cash). The drawer cannot
 * be split without making it negative, so `ok` is false and the caller must
 * refuse the automatic fix instead of inventing money.
 *
 * @param {number|string} live
 * @param {number|string} asOf
 * @returns {{ok: boolean, live: number, kept: number, today: number}}
 */
function shiftCashSplit(live, asOf) {
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const liveNow = round2(live);
  const kept = Math.max(0, round2(asOf));
  const today = round2(liveNow - kept);
  return { ok: today >= 0, live: liveNow, kept, today };
}

/**
 * Combine a date input value ("YYYY-MM-DD") and a time input value ("HH:MM"
 * or "HH:MM:SS") into the MySQL DATETIME the server stores.
 *
 * Returns null when either part is missing or out of range, so the admin form
 * can reject bad input before sending anything.
 */
function shiftCloseTimestamp(dateString, timeString) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || "").trim());
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(timeString || "").trim()
  );
  if (!dm || !tm) return null;

  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  const second = Number(tm[3] || 0);

  const dt = new Date(year, month - 1, day, hour, minute, second);
  // Reject impossible values such as 2026-02-31 or 24:00 (Date would roll
  // them over instead of failing).
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day ||
    dt.getHours() !== hour ||
    dt.getMinutes() !== minute ||
    dt.getSeconds() !== second
  ) {
    return null;
  }

  const p = (n) => String(n).padStart(2, "0");
  return (
    `${year}-${p(month)}-${p(day)} ` +
    `${p(hour)}:${p(minute)}:${p(second)}`
  );
}

/**
 * True when the selected shift end lies in the future. Closing a shift is a
 * correction of the past, so the admin form refuses future timestamps.
 */
function shiftCloseIsFuture(timestamp, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    String(timestamp || "")
  );
  if (!m) return false;
  const dt = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  );
  return dt.getTime() > now.getTime();
}
