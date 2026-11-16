"use strict";

// ---------------------------------------------------------------------------
// API host - the ONLY place in the client that names the server.
//
// Everything else derives from this file:
//   * the Content-Security-Policy and the outbox allow-list (main.js),
//   * the WebSocket handshake probe and the server diagnostics (main.js),
//   * the renderer's API_BASE / WS_URL (main.js -> renderer/preload.js).
// When the API moves, change API_DOMAIN below and rebuild.
// ---------------------------------------------------------------------------

export const API_DOMAIN = "bulsig.online";

export const API_BASE = `https://${API_DOMAIN}`;
export const WS_URL = `wss://${API_DOMAIN}/ws`;

// Local renderer dev server (Electron pointing at an API started by hand).
// Kept in the CSP and in the outbox allow-list so local work needs no edits.
export const DEV_ORIGINS = ["http://127.0.0.1:5501", "http://localhost:5501"];

// Origins the outbox may queue requests for (same list as the CSP).
export const ALLOWED_API_ORIGINS = [API_BASE, ...DEV_ORIGINS];

// connect-src: the API origin, its WebSocket origin and the local dev server
// (plain + socket scheme).
const CONNECT_SRC = Array.from(
  new Set([
    "'self'",
    API_BASE,
    `wss://${API_DOMAIN}`,
    ...DEV_ORIGINS,
    ...DEV_ORIGINS.map((origin) => origin.replace(/^http:/, "ws:")),
  ])
).join(" ");

export const CONTENT_SECURITY_POLICY =
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${CONNECT_SRC}`,
    "manifest-src 'self'",
  ].join("; ") + ";";

// Strings handed to the renderer through webPreferences.additionalArguments and
// read by renderer/preload.js, so no renderer file repeats the host.
export const RENDERER_ARGS = [`--api-base=${API_BASE}`, `--ws-url=${WS_URL}`];

// Single object used by main.js.
export const API = {
  domain: API_DOMAIN,
  apiBase: API_BASE,
  wsUrl: WS_URL,
  allowedOrigins: ALLOWED_API_ORIGINS,
  csp: CONTENT_SECURITY_POLICY,
  rendererArgs: RENDERER_ARGS,
};
