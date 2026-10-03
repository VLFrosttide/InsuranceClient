"use strict";

// Shared helpers for the InsuranceClient renderer.
// Load this file before any page-specific logic script.

const API_BASE = "https://lavender-quail-935384.hostingersite.com";
const WS_URL = "wss://lavender-quail-935384.hostingersite.com/ws";

const ROLE_LABELS = { 1: "Admin", 2: "Worker", 3: "Client" };

function getToken() {
  return localStorage.getItem("token") || "";
}
function getUsername() {
  return localStorage.getItem("username") || "";
}
function getRole() {
  return localStorage.getItem("role") || "";
}

function clearSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  localStorage.removeItem("role");
}

function redirectToLogin() {
  clearSession();
  window.bridge.LoadNewPage("renderer/LoginPage/index.html");
}

// Fetch helper that attaches the Bearer token and handles 401 globally.
async function api(path, options = {}) {
  const headers = Object.assign(
    { Authorization: `Bearer ${getToken()}` },
    options.headers || {}
  );
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (res.status === 401) {
    redirectToLogin();
    throw new Error(data.error || "Session expired");
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// DOM factory.
function el(tag, text, attrs) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (attrs) {
    for (const key in attrs) {
      if (key === "class") node.className = attrs[key];
      else if (key === "type") node.type = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
  }
  return node;
}

// Toast notification.
let toastTimer = null;
function toast(text, type = "info") {
  if (!text) return;
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const node = el("div", text, { class: `toast ${type}` });
  document.body.appendChild(node);

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3500);
}

// Guard pages that require login.
function requireLogin() {
  if (!getToken()) {
    redirectToLogin();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket helper for unread-email workflows.
//
// The server authenticates the socket with the same Bearer token used by the
// REST API. Messages sent with `send()` before authentication are queued and
// flushed automatically once the server acknowledges `auth_ok`.
// ---------------------------------------------------------------------------
class UnreadEmailSocket {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.authed = false;
    this.pending = [];
  }

  connect() {
    if (this.ws) return;

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error("WebSocket error:", err);
      if (this.handlers.close) this.handlers.close(err);
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: getToken() }));
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "auth_ok") {
        this.authed = true;
        this.flush();
        if (this.handlers.auth_ok) this.handlers.auth_ok(msg);
        return;
      }

      if (msg.type === "auth_error") {
        if (this.handlers.auth_error) {
          this.handlers.auth_error(msg);
        } else {
          redirectToLogin();
        }
        return;
      }

      if (this.handlers[msg.type]) this.handlers[msg.type](msg);
      if (this.handlers["*"]) this.handlers["*"](msg);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.authed = false;
      if (this.handlers.close) this.handlers.close();
    });

    ws.addEventListener("error", () => {
      // A close event follows and resets connection state.
    });
  }

  send(obj) {
    if (this.authed && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      this.pending.push(obj);
    }
  }

  flush() {
    while (
      this.authed &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.pending.length
    ) {
      this.ws.send(JSON.stringify(this.pending.shift()));
    }
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.authed = false;
    this.pending = [];
  }
}
