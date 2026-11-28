"use strict";
// Bulins border-insurance web form, embedded in the app with a WebContentsView.
//
// Opening an email or a new walk-in insurance used to navigate to the in-app
// AddInsurance form. It now shows the Bulins online platform instead, layered
// over the main window. While the worker fills in and submits the Bulins form
// (and navigates on to the pages it produces), every page is scraped - form
// fields, tables and body text - and persisted so it can later be turned into
// an insurance record for our server.

import { app, WebContentsView } from "electron";
import path from "path";
import fs from "fs";

export const BULINS_START_URL =
  "https://online.bulins.bg/ims/tpl/BorderClientStep.isc?instype=border";

// Keep at most this many scrape snapshots on disk.
const MAX_SCRAPE_FILES = 200;

// ---------------------------------------------------------------------------
// Injected into the Bulins page on every load. Runs in the page's main world
// and returns a JSON-serialisable snapshot. It is deliberately defensive so a
// page we do not control can never break the flow.
// ---------------------------------------------------------------------------
const SCRAPE_SCRIPT = String.raw`
(() => {
  try {
    var str = function (v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); };

    var inputs = [];
    var nodes = document.querySelectorAll("input, select, textarea");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.type === "hidden") continue;
      var selectedText = "";
      if (el.tagName === "SELECT") {
        var opt = el.options[el.selectedIndex];
        if (opt) selectedText = str(opt.text || opt.value);
      }
      var state = "";
      if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
        state = el.checked ? "checked" : "";
      }
      var label = "";
      if (el.id) {
        var lab = document.querySelector('label[for="' + el.id + '"]');
        if (lab) label = str(lab.innerText || lab.textContent);
      }
      if (!label && el.closest) {
        var wrap = el.closest("label");
        if (wrap) label = str(wrap.innerText || wrap.textContent);
      }
      inputs.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        name: el.name || "",
        id: el.id || "",
        label: label,
        value: el.value || "",
        selectedText: selectedText,
        state: state,
        placeholder: el.placeholder || ""
      });
    }

    var tables = [];
    var tNodes = document.querySelectorAll("table");
    for (var j = 0; j < tNodes.length; j++) {
      var rows = [];
      var trs = tNodes[j].querySelectorAll("tr");
      for (var k = 0; k < trs.length; k++) {
        var cells = [];
        var tds = trs[k].querySelectorAll("th, td");
        for (var m = 0; m < tds.length; m++) {
          var cell = str(tds[m].innerText || tds[m].textContent);
          if (cell) cells.push(cell);
        }
        if (cells.length) rows.push(cells);
      }
      if (rows.length) tables.push(rows);
    }

    return {
      url: location.href,
      title: document.title || "",
      lang: (document.documentElement && document.documentElement.lang) || "",
      inputs: inputs,
      tables: tables,
      bodyText: str(document.body ? (document.body.innerText || document.body.textContent) : "").slice(0, 20000)
    };
  } catch (e) {
    return { url: location.href, error: String((e && e.message) || e) };
  }
})()
`;

// Keyword hints used to map a scraped input onto our insurance columns. The
// mapping is best-effort: Bulins may rename fields, so it is deliberately
// lenient and easy to extend. Each hint list is checked against the input's
// label / name / id / placeholder text (lowercased).
const FIELD_TARGETS = [
  ["PolicyNumber", ["polic", "polisa", "policy", "полица"]],
  ["BlancNumber", ["blanc", "formul", "бланка", "бланк", "блан"]],
  ["CarNumber", ["reg", "plate", "car number", "рег", "автомобил", "номер автомобил"]],
  ["StartDate", ["start", "begin", "valid from", "начал", "дата"]],
  ["Duration", ["duration", "period", "validity", "срок", "дни", "месец"]],
  ["Otomobil", ["otomobil", "vehicle", "превозно", "тип", "вид", "mps"]],
  ["Price", ["price", "amount", "total", "premia", "цена", "сума", "общо"]],
  ["CurrencyType", ["currency", "валута", "curr"]],
];

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Pick the best matching scraped input for one insurance field. Inputs that
// already carry a value are preferred, so the generated policy/blanc numbers
// on the result page win over empty inputs on the entry page.
function extractInsuranceRecord(snapshot) {
  const inputs = (snapshot && snapshot.inputs) || [];
  const record = {};

  for (const [key, keywords] of FIELD_TARGETS) {
    let best = null;
    let bestScore = 0;
    for (const input of inputs) {
      const text = normalize(
        [input.label, input.name, input.id, input.placeholder].join(" ")
      );
      if (!text) continue;
      let score = 0;
      for (const kw of keywords) if (text.includes(kw)) score += 1;
      if (score === 0) continue;
      if (input.value || input.selectedText) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = input;
      }
    }
    if (best) {
      const value = String(best.selectedText || best.value || "").trim();
      if (value) record[key] = value;
    }
  }
  return record;
}

export class BulinsController {
  constructor({ getWindow, onScraped, onClosed }) {
    this.getWindow = getWindow || (() => null);
    this.onScraped = typeof onScraped === "function" ? onScraped : () => {};
    this.onClosed = typeof onClosed === "function" ? onClosed : () => {};
    this.view = null;
    this.isOpen = false;
    this.context = null; // { mode: "email" | "walkin", email? }
    this.dataDir = path.join(app.getPath("userData"), "bulins-scrapes");
    this.lastSnapshots = [];
  }

  getState() {
    return { open: this.isOpen, context: this.context, startUrl: BULINS_START_URL };
  }

  ensureView() {
    const win = this.getWindow();
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    if (this.view && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(this.view);
      } catch (err) {
        console.error("[Bulins] failed to remove a stale view:", err);
      }
    }

    this.view = new WebContentsView({
      webPreferences: {
        // A dedicated persistent session keeps the worker logged in to Bulins
        // across app restarts, independent of the app's own session.
        partition: "persist:bulins",
        preload: path.join(app.getAppPath(), "renderer", "bulinsViewPreload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const wc = this.view.webContents;

    // Any popup / target=_blank link stays inside the same view so navigation
    // (and therefore scraping) is never lost to a separate window.
    wc.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:/i.test(url)) {
        wc.loadURL(url).catch(() => {});
      }
      return { action: "deny" };
    });

    wc.on("did-finish-load", () => {
      this.injectBackButton();
      this.scrape();
    });
    wc.on("dom-ready", () => {
      // Belt-and-braces: make sure the back button exists even on pages that
      // never report did-finish-load with a usable document.
      this.injectBackButton();
    });
    wc.on("did-navigate", (_event, url) => {
      console.log(`[Bulins] navigated to ${url}`);
    });
    wc.on("did-fail-load", (_event, errorCode, errorDescription, url) => {
      console.error(
        `[Bulins] failed to load ${url} (${errorCode}${
          errorDescription ? ": " + errorDescription : ""
        })`
      );
      // The error page can still host the back button so the worker can return.
      this.injectBackButton();
    });
    // Ctrl/Cmd+Shift+B closes the Bulins form - a fallback for pages where the
    // floating button cannot be injected.
    wc.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        (input.control || input.meta) &&
        input.shift &&
        (input.key === "b" || input.key === "B")
      ) {
        event.preventDefault();
        this.close("shortcut");
      }
    });
    wc.on("render-process-gone", (_event, details) => {
      console.error(
        "[Bulins] renderer gone:",
        (details && details.reason) || "unknown"
      );
    });

    return this.view;
  }

  layout() {
    const win = this.getWindow();
    if (!this.view || !win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    this.view.setBounds({
      x: 0,
      y: 0,
      width: Math.max(0, width),
      height: Math.max(0, height),
    });
  }

  open(context) {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "The main window is not available." };
    }

    this.context =
      context && typeof context === "object" ? context : { mode: "walkin" };

    const view = this.ensureView();
    if (!this.isOpen) {
      win.contentView.addChildView(view);
      this.isOpen = true;
      if (!this.resizeBound) {
        this.resizeBound = true;
        win.on("resize", () => this.layout());
      }
    }

    this.layout();
    view.webContents.loadURL(BULINS_START_URL).catch((err) => {
      console.error("[Bulins] failed to open the start page:", err);
    });
    view.webContents.focus();
    console.log(`[Bulins] opened in ${this.context.mode || "walkin"} mode`);
    return { ok: true };
  }

  close(reason) {
    if (!this.isOpen) return;
    const win = this.getWindow();
    this.isOpen = false;
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(this.view);
      } catch (err) {
        console.error("[Bulins] failed to remove the view:", err);
      }
    }
    const context = this.context;
    this.context = null;
    console.log(`[Bulins] closed (${reason || "user"})`);
    this.onClosed(context);
  }

  injectBackButton() {
    const wc = this.view && this.view.webContents;
    if (!wc || wc.isDestroyed()) return;

    const script = String.raw`
(() => {
  try {
    if (document.getElementById("__insurance_back_button__")) return;
    var host = document.createElement("div");
    host.id = "__insurance_back_button__";
    var shadow = host.attachShadow({ mode: "open" });

    var bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:2147483647;" +
      "display:flex;gap:8px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;";

    var back = document.createElement("button");
    back.type = "button";
    back.textContent = "← Insurance";
    back.style.cssText =
      "padding:8px 14px;background:#0b6efd;color:#fff;border:none;" +
      "border-radius:6px;font-size:14px;cursor:pointer;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.35);";
    back.addEventListener("click", function () {
      try { if (window.bulinsBridge && window.bulinsBridge.close) window.bulinsBridge.close(); }
      catch (e) { console.error(e); }
    });

    bar.appendChild(back);
    shadow.appendChild(bar);
    (document.body || document.documentElement).appendChild(host);
  } catch (e) {}
})()
`;
    wc.executeJavaScript(script, true).catch(() => {});
  }

  async scrape() {
    const wc = this.view && this.view.webContents;
    if (!wc || wc.isDestroyed()) return null;

    let snapshot;
    try {
      snapshot = await wc.executeJavaScript(SCRAPE_SCRIPT, true);
    } catch (err) {
      console.error("[Bulins] scrape failed:", err);
      return null;
    }
    if (!snapshot || typeof snapshot !== "object") return null;

    const record = extractInsuranceRecord(snapshot);
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      capturedAt: new Date().toISOString(),
      mode: this.context && this.context.mode ? this.context.mode : "walkin",
      emailFrom:
        this.context && this.context.email && this.context.email.from
          ? this.context.email.from
          : "",
      messageId:
        this.context && this.context.email && this.context.email.messageId
          ? this.context.email.messageId
          : null,
      url: snapshot.url || "",
      title: snapshot.title || "",
      record,
      snapshot,
    };

    await this.persist(entry);
    this.lastSnapshots.push(entry);
    while (this.lastSnapshots.length > 20) this.lastSnapshots.shift();
    this.onScraped(entry);

    const filled = Object.keys(record).filter((k) => record[k]).length;
    console.log(`[Bulins] scraped ${filled} field(s) from ${entry.url}`);
    return entry;
  }

  async persist(entry) {
    try {
      await fs.promises.mkdir(this.dataDir, { recursive: true });
      const file = path.join(this.dataDir, `${entry.id}.json`);
      await fs.promises.writeFile(file, JSON.stringify(entry, null, 2), "utf8");

      // Bound the on-disk history: older snapshots are dropped first.
      const files = (await fs.promises.readdir(this.dataDir))
        .filter((n) => n.endsWith(".json"))
        .sort();
      while (files.length > MAX_SCRAPE_FILES) {
        const oldest = files.shift();
        await fs.promises.unlink(path.join(this.dataDir, oldest)).catch(() => {});
      }
    } catch (err) {
      console.error("[Bulins] failed to persist a scrape:", err);
    }
  }

  async listScrapes(limit = 50) {
    const count = Math.min(Math.max(Number(limit) || 50, 1), 200);
    try {
      const files = (await fs.promises.readdir(this.dataDir))
        .filter((n) => n.endsWith(".json"))
        .sort()
        .reverse();
      const out = [];
      for (const name of files.slice(0, count)) {
        try {
          const raw = JSON.parse(
            await fs.promises.readFile(path.join(this.dataDir, name), "utf8")
          );
          out.push({
            id: raw.id,
            capturedAt: raw.capturedAt,
            mode: raw.mode,
            url: raw.url,
            title: raw.title,
            record: raw.record,
            emailFrom: raw.emailFrom,
            messageId: raw.messageId,
          });
        } catch {
          // Skip corrupt files.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
