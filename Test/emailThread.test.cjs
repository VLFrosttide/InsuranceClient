"use strict";

// Node test for splitting email replies into the separate emails they contain
// (renderer/emailThread.js), so the email cards / side panel can show where
// one email ends and the next starts.
//
// Runs the REAL renderer file in a vm (it is a classic browser <script>), plus
// the server's htmlToRoughText (InsuranceServer/Mail/ProcessEmail.js, see
// Test/serverPath.cjs) to check that HTML-only replies keep enough structure
// to be split.
//
// Run with:  node Test/emailThread.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const ROOT = path.join(__dirname, "..");
const CTX = { console };
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, "renderer", "emailThread.js"), "utf8"),
  CTX,
  { filename: "emailThread.js" }
);
const { splitEmailThread, emailThreadInfo } = CTX;

// htmlToRoughText is private to the server module: cut it out of the file.
const processSrc = fs.readFileSync(serverFile("Mail", "ProcessEmail.js"), "utf8");
const fnStart = processSrc.indexOf("function htmlToRoughText(");
// The server file may use CRLF line endings.
const fnEndMatch = /\r?\nfunction uniqueFileName\(/.exec(processSrc);
const fnEnd = fnEndMatch ? fnEndMatch.index : -1;
if (fnStart < 0 || fnEnd < fnStart) {
  console.error("Could not locate htmlToRoughText in Mail/ProcessEmail.js");
  process.exit(1);
}
vm.runInContext(processSrc.slice(fnStart, fnEnd), CTX, {
  filename: "Mail/ProcessEmail.js#htmlToRoughText",
});
const { htmlToRoughText } = CTX;

// --- tiny assert helper ------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message ? err.message : err));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
const texts = (segments) => segments.map((s) => s.text);

// --- plain emails stay whole -------------------------------------------------
check("a plain email is a single segment and not a reply", () => {
  const body = "Hello,\nplease issue a policy for CA1234AB.\n\nThanks";
  const info = emailThreadInfo({ subject: "Policy CA1234AB", body });
  eq(info.kind, null, "kind");
  eq(texts(info.segments), [body], "segments");
});

check("an empty body still yields one (empty) segment", () => {
  eq(texts(splitEmailThread("")), [""], "segments");
});

check("Bulgarian 'От:' date ranges inside a request are not split", () => {
  const body = "Полица за CA1234AB\nОт: 15.05.2026\nДо: 15.06.2026\nТема: ГО";
  eq(splitEmailThread(body).length, 1, "segment count");
});

check("a plain sentence ending in 'wrote:' is not a separator", () => {
  const body = "This is what the client wrote:\nplease renew";
  eq(splitEmailThread(body).length, 1, "segment count");
});

// --- Gmail-style replies -----------------------------------------------------
check("Gmail reply: new text + quoted original are separate", () => {
  const body = [
    "Here is the second car: PB5678CC",
    "",
    "On Mon, 5 Oct 2026 at 10:12, Broker One <broker@example.com> wrote:",
    "",
    "> Please issue a policy for CA1234AB.",
    "> Thanks",
  ].join("\n");
  const info = emailThreadInfo({ subject: "Re: Policy", body });
  eq(info.kind, "reply", "kind");
  eq(
    texts(info.segments),
    [
      "Here is the second car: PB5678CC",
      "Please issue a policy for CA1234AB.\nThanks",
    ],
    "segments"
  );
  eq(info.segments[1].from, "Broker One <broker@example.com>", "from");
  eq(info.segments[1].date, "Mon, 5 Oct 2026 at 10:12", "date");
});

check("attribution wrapped over two lines is recognised", () => {
  const body = [
    "Done.",
    "",
    "On Mon, 5 Oct 2026 at 10:12, Broker One <broker@example.com>",
    "wrote:",
    "> original text",
  ].join("\n");
  eq(texts(splitEmailThread(body)), ["Done.", "original text"], "segments");
});

check("nested quotes become one segment per email", () => {
  const body = [
    "Third email",
    "",
    "On Tue, Oct 6, 2026 at 9:00 AM Office <office@example.com> wrote:",
    "> Second email",
    ">",
    "> On Mon, Oct 5, 2026 at 8:00 AM Broker <broker@example.com> wrote:",
    ">> First email",
  ].join("\n");
  const segs = splitEmailThread(body);
  eq(texts(segs), ["Third email", "Second email", "First email"], "segments");
  eq(segs[1].from, "Office <office@example.com>", "second from");
  eq(segs[2].from, "Broker <broker@example.com>", "third from");
});

check("Bulgarian and Turkish attributions are recognised", () => {
  const bg =
    "Ок\n\nНа пн, 5.10.2026 г. в 10:12 Брокер <b@example.com> написа:\n> Здравейте";
  eq(texts(splitEmailThread(bg)), ["Ок", "Здравейте"], "bg");
  const tr =
    "Tamam\n\n5 Eki 2026 Pzt 10:12 tarihinde Broker <b@example.com> şunu yazdı:\n> Merhaba";
  const trSegs = splitEmailThread(tr);
  eq(texts(trSegs), ["Tamam", "Merhaba"], "tr");
  eq(trSegs[1].from, "Broker <b@example.com>", "tr from");
});

check("a trailing '>' block without attribution is still separated", () => {
  const body = "New text\n\n> old line 1\n> old line 2";
  eq(
    texts(splitEmailThread(body)),
    ["New text", "old line 1\nold line 2"],
    "segments"
  );
});

// --- Outlook-style replies ---------------------------------------------------
check("Outlook reply with an underscore rule and header block", () => {
  const body = [
    "Please see below.",
    "",
    "________________________________",
    "From: Broker One <broker@example.com>",
    "Sent: Monday, October 5, 2026 10:12 AM",
    "To: office@example.com",
    "Subject: Policy CA1234AB",
    "",
    "Please issue a policy.",
  ].join("\n");
  const segs = splitEmailThread(body);
  eq(texts(segs), ["Please see below.", "Please issue a policy."], "segments");
  eq(segs[1].from, "Broker One <broker@example.com>", "from");
  eq(segs[1].date, "Monday, October 5, 2026 10:12 AM", "date");
  eq(segs[1].subject, "Policy CA1234AB", "subject");
});

check("'-----Original Message-----' divider splits the email", () => {
  const body = [
    "Answer",
    "-----Original Message-----",
    "From: Broker <broker@example.com>",
    "Sent: 05.10.2026 10:12",
    "Subject: Request",
    "Original",
  ].join("\n");
  const segs = splitEmailThread(body);
  eq(texts(segs), ["Answer", "Original"], "segments");
  eq(segs[1].date, "05.10.2026 10:12", "date");
});

check("Bulgarian Outlook header block (От / Изпратено / До / Тема)", () => {
  const body = [
    "Отговор",
    "",
    "От: Брокер <b@example.com>",
    "Изпратено: 5 октомври 2026 10:12",
    "До: office@example.com",
    "Тема: Полица",
    "",
    "Оригинал",
  ].join("\n");
  eq(texts(splitEmailThread(body)), ["Отговор", "Оригинал"], "segments");
});

check("Forwarded message gets the forward kind", () => {
  const body = [
    "FYI",
    "",
    "---------- Forwarded message ---------",
    "From: Broker <broker@example.com>",
    "Date: Mon, Oct 5, 2026 at 10:12 AM",
    "Subject: Policy",
    "To: <office@example.com>",
    "",
    "Original request",
  ].join("\n");
  const info = emailThreadInfo({ subject: "Fwd: Policy", body });
  eq(info.kind, "forward", "kind");
  eq(texts(info.segments), ["FYI", "Original request"], "segments");
});

check("'Re:' subject marks a reply even when nothing is quoted", () => {
  const info = emailThreadInfo({ subject: "RE: Policy", body: "Only new text" });
  eq(info.kind, "reply", "kind");
  eq(info.count, 1, "count");
});

check("an empty reply above the quote keeps the quote with its header", () => {
  const body =
    "On Mon, Oct 5, 2026 at 8:00 AM Broker <b@example.com> wrote:\n> First";
  const segs = splitEmailThread(body);
  eq(texts(segs), ["First"], "segments");
  eq(segs[0].from, "Broker <b@example.com>", "from");
});

// --- HTML-only replies -------------------------------------------------------
check("htmlToRoughText keeps line breaks and blockquote levels", () => {
  const html =
    '<div dir="ltr">New text<br>line 2</div><br>' +
    '<div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 5, 2026 at 8:00 AM Broker &lt;<a href="mailto:b@example.com">b@example.com</a>&gt; wrote:<br></div>' +
    '<blockquote class="gmail_quote"><div>Old &amp; quoted</div></blockquote></div>';
  const segs = splitEmailThread(htmlToRoughText(html));
  eq(texts(segs), ["New text\nline 2", "Old & quoted"], "segments");
  eq(segs[1].from, "Broker <b@example.com>", "from");
});

check("htmlToRoughText decodes entities without double-decoding", () => {
  eq(htmlToRoughText("<p>a&nbsp;&lt;b&gt; &amp;lt;</p>"), "a <b> &lt;", "text");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

