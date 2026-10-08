"use strict";

// Pure, DOM-free helpers that split an email body into the individual emails
// it contains. A reply's body holds the new text followed by the quoted
// earlier message(s) ("On ... wrote:" + "> " lines, Outlook's
// "From: / Sent: / To: / Subject:" block, "-----Original Message-----", ...).
// Splitting them lets the UI show each email in its own visually separate box.
//
// Kept in a separate classic <script> (no DOM access) so the exact same code
// runs in the browser and in the Node test harness (Test/emailThread.test.cjs).

// Header field names (lower-case, as written by mail clients in several
// languages) mapped to the field they describe.
const EMAIL_HEADER_FIELDS = {
  from: "from",
  "от": "from",
  kimden: "from",
  "gönderen": "from",
  von: "from",
  de: "from",

  sent: "date",
  date: "date",
  "изпратено": "date",
  "изпратен": "date",
  "дата": "date",
  "gönderildi": "date",
  tarih: "date",
  gesendet: "date",
  datum: "date",
  "envoyé": "date",

  to: "to",
  "до": "to",
  kime: "to",
  "alıcı": "to",
  an: "to",
  "à": "to",

  cc: "cc",
  bcc: "cc",
  "копие": "cc",
  bilgi: "cc",

  subject: "subject",
  "тема": "subject",
  konu: "subject",
  betreff: "subject",
  objet: "subject",
};

// "On <date>, <name> wrote:" style attribution lines.
const EMAIL_ATTRIBUTION_START_RE = /^(on|am|le|el|il|op|em|на|в)\s/i;
const EMAIL_ATTRIBUTION_END_RE =
  /(wrote|writes|schrieb|a écrit|escribió|ha scritto|schreef|escreveu|написа|пише|şunu yazdı|yazdı)\s*:\s*$/i;

// Words that end the date part of an attribution (never part of a name).
const EMAIL_ATTRIBUTION_STOP_RE =
  /^(am|pm|at|um|à|tarihinde|saat|г\.?|в|ч\.?|uhr)$/i;

// "-----Original Message-----" / "---------- Forwarded message ---------".
const EMAIL_DIVIDER_RE =
  /^-{2,}\s*(original message|forwarded message|оригинално съобщение|препратено съобщение|orijinal mesaj|özgün ileti|iletilen ileti|ursprüngliche nachricht|weitergeleitete nachricht|message d'origine|message transféré)\s*-{2,}$/i;
// Outlook separates the quoted message with a long underscore rule.
const EMAIL_RULE_RE = /^_{8,}$/;

// Reply / forward subject prefixes ("Re:", "RE[2]:", "Отг:", "Fwd:", ...).
const EMAIL_REPLY_SUBJECT_RE =
  /^\s*(re|aw|sv|vs|odp|ynt|antw|отг)\s*(\[\d+\])?\s*:/i;
const EMAIL_FORWARD_SUBJECT_RE = /^\s*(fwd?|wg|tr|ilt|пр)\s*(\[\d+\])?\s*:/i;

const EMAIL_MAX_QUOTE_DEPTH = 20;

function emailParseHeaderLine(line) {
  const m =
    /^\s*\*{0,2}([^:*\s][^:*]{0,24}?)\s*\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/.exec(
      String(line || "")
    );
  if (!m) return null;
  const field = EMAIL_HEADER_FIELDS[m[1].trim().toLowerCase()];
  return field ? { field, value: m[2].trim() } : null;
}

// Read consecutive header lines ("From: ...", "Sent: ...") starting at `start`.
function emailReadHeaderBlock(lines, start) {
  const fields = { from: "", date: "", subject: "" };
  let j = start;
  let count = 0;
  while (j < lines.length) {
    const header = emailParseHeaderLine(lines[j]);
    if (!header) break;
    if (header.field in fields && !fields[header.field]) {
      fields[header.field] = header.value;
    }
    count++;
    j++;
  }
  return { fields, count, next: j };
}

function emailParseAttribution(text) {
  let rest = text
    // HTML-to-text turns "&lt;<a>x@y</a>&gt;" into "< x@y >".
    .replace(/<\s+/g, "<")
    .replace(/\s+>/g, ">")
    .replace(EMAIL_ATTRIBUTION_END_RE, "")
    .replace(EMAIL_ATTRIBUTION_START_RE, "")
    .trim()
    .replace(/[,\s]+$/, "");
  let from = "";
  const angle = /<[^<>\s]+@[^<>\s]+>$/.exec(rest);
  const bare = angle ? null : /[^\s<>,]+@[^\s<>,]+$/.exec(rest);
  if (angle) {
    // The display name is the run of words right before "<address>"; stop at
    // anything that belongs to the date ("10:12", "AM", "tarihinde", ...).
    let before = rest.slice(0, angle.index).trimEnd();
    let name = "";
    const quoted = /"([^"]*)"$/.exec(before);
    if (quoted) {
      name = quoted[1].trim();
      before = before.slice(0, quoted.index);
    } else {
      const words = before.split(/\s+/);
      const nameWords = [];
      while (words.length) {
        const word = words[words.length - 1];
        if (!word || /[\d,]/.test(word) || EMAIL_ATTRIBUTION_STOP_RE.test(word)) {
          break;
        }
        nameWords.unshift(words.pop());
      }
      name = nameWords.join(" ");
      before = words.join(" ");
    }
    from = name ? `${name} ${angle[0]}` : angle[0];
    rest = before;
  } else if (bare) {
    from = bare[0];
    rest = rest.slice(0, bare.index);
  }
  const date = rest
    .replace(/\s+tarihinde$/i, "")
    .trim()
    .replace(/[,\s]+$/, "");
  return { from, date, subject: "", attribution: text };
}

function emailMatchAttribution(lines, i) {
  const first = lines[i].trim();
  if (!first) return null;
  for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
    const last = lines[i + span - 1].trim();
    if (span > 1 && (!last || /^>/.test(last))) return null;
    const joined = lines
      .slice(i, i + span)
      .map((s) => s.trim())
      .join(" ")
      .trim();
    if (joined.length > 400) return null;
    if (!EMAIL_ATTRIBUTION_END_RE.test(joined)) continue;
    const startsLikeAttribution = EMAIL_ATTRIBUTION_START_RE.test(first);
    // Wrapped attributions must start like one; single lines must at least
    // carry an address or a date to avoid splitting on a plain "... wrote:".
    if (span > 1 && !startsLikeAttribution) return null;
    if (!startsLikeAttribution && !/[@\d]/.test(joined)) return null;
    return { next: i + span, ...emailParseAttribution(joined) };
  }
  return null;
}

function emailMatchDivider(lines, i) {
  const line = lines[i].trim();
  const isDivider = EMAIL_DIVIDER_RE.test(line);
  if (!isDivider && !EMAIL_RULE_RE.test(line)) return null;
  let j = i + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  const block = emailReadHeaderBlock(lines, j);
  // A bare underscore rule only separates emails when headers follow it.
  if (!isDivider && !block.fields.from) return null;
  if (!block.count) {
    return { next: i + 1, from: "", date: "", subject: "", attribution: "" };
  }
  return { next: block.next, ...block.fields, attribution: "" };
}

// Outlook-style header block without a divider line above it. Stricter than
// after a divider: broker requests can legitimately contain lines such as
// "От: 15.05" (Bulgarian "from" in a date range), so at least three header
// lines are required and the sender must not look like a number/date.
function emailMatchHeaderBlock(lines, i) {
  const first = emailParseHeaderLine(lines[i]);
  if (!first || first.field !== "from") return null;
  if (!/\p{L}/u.test(first.value) || /^[\d\s./-]/.test(first.value)) {
    return null;
  }
  const block = emailReadHeaderBlock(lines, i);
  if (block.count < 3) return null;
  if (!block.fields.date && !block.fields.subject) return null;
  return { next: block.next, ...block.fields, attribution: "" };
}

function emailMatchSeparator(lines, i) {
  // Quoted lines are split later, after one quote level is stripped.
  if (/^\s*>/.test(lines[i])) return null;
  return (
    emailMatchDivider(lines, i) ||
    emailMatchHeaderBlock(lines, i) ||
    emailMatchAttribution(lines, i)
  );
}

function emailNewSegment(header) {
  return {
    from: (header && header.from) || "",
    date: (header && header.date) || "",
    subject: (header && header.subject) || "",
    attribution: (header && header.attribution) || "",
    lines: [],
  };
}

function emailHasHeader(segment) {
  return Boolean(segment.from || segment.date || segment.attribution);
}

// A trailing block of "> " lines is an earlier email quoted inline: strip one
// quote level and split it on its own (handles nested replies recursively).
function emailUnquoteSegment(segment, depth) {
  const lines = segment.lines;
  let start = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (/^\s*>/.test(lines[k])) start = k;
    else if (lines[k].trim() !== "") break;
  }
  if (start < 0 || depth >= EMAIL_MAX_QUOTE_DEPTH) return [segment];

  const head = lines.slice(0, start);
  const quoted = lines.slice(start).map((l) => l.replace(/^\s*> ?/, ""));
  const inner = emailSplitLines(quoted, depth + 1);
  const out = [];
  if (head.some((l) => l.trim())) {
    out.push({ ...segment, lines: head });
  } else if (inner.length && !emailHasHeader(inner[0])) {
    // Only quoted text under this header: the quote IS this email.
    Object.assign(inner[0], {
      from: segment.from,
      date: segment.date,
      subject: segment.subject,
      attribution: segment.attribution,
    });
  } else if (emailHasHeader(segment)) {
    out.push({ ...segment, lines: [] });
  }
  return out.concat(inner);
}

function emailSplitLines(lines, depth) {
  const raw = [];
  let current = emailNewSegment(null);
  let i = 0;
  while (i < lines.length) {
    const sep = emailMatchSeparator(lines, i);
    if (sep) {
      raw.push(current);
      current = emailNewSegment(sep);
      i = sep.next;
      continue;
    }
    current.lines.push(lines[i]);
    i++;
  }
  raw.push(current);

  const out = [];
  for (const segment of raw) out.push(...emailUnquoteSegment(segment, depth));
  return out;
}

function emailSegmentText(lines) {
  return lines
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

/**
 * Split an email body into the individual emails it contains, newest first.
 *
 * @param {string} body  Plain-text email body.
 * @returns {Array<{from: string, date: string, subject: string,
 *   attribution: string, text: string}>}  Always at least one entry.
 */
function splitEmailThread(body) {
  const lines = String(body || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const segments = emailSplitLines(lines, 0)
    .map((s) => ({
      from: s.from,
      date: s.date,
      subject: s.subject,
      attribution: s.attribution,
      text: emailSegmentText(s.lines),
    }))
    // Drop empty fragments, but keep an earlier email whose body is empty so
    // its header still shows where it starts.
    .filter((s, idx) => s.text || (idx > 0 && emailHasHeader(s)));
  if (segments.some((s) => s.text)) return segments;
  return [
    {
      from: "",
      date: "",
      subject: "",
      attribution: "",
      text: String(body || "").trim(),
    },
  ];
}

/**
 * Describe an email as a thread.
 *
 * @param {{subject?: string, body?: string}} email
 * @returns {{kind: ("reply"|"forward"|null), segments: Array, count: number}}
 *   kind is null for a plain (non-reply) email.
 */
function emailThreadInfo(email) {
  const subject = (email && email.subject) || "";
  const segments = splitEmailThread(email && email.body);
  let kind = null;
  if (EMAIL_REPLY_SUBJECT_RE.test(subject)) kind = "reply";
  else if (EMAIL_FORWARD_SUBJECT_RE.test(subject)) kind = "forward";
  else if (segments.length > 1) kind = "reply";
  return { kind, segments, count: segments.length };
}

