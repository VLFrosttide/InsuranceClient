// Raw WebSocket-upgrade prober for the Insurance deployment.
//
// The browser WebSocket API hides redirects: a 3xx (like the intermittent 307
// the app sees) is only surfaced as "Unexpected response code: 307", with no
// way to learn WHERE the CDN wanted to redirect. This script performs the raw
// HTTP/1.1 upgrade handshake itself so it can print the status line and the
// Location header the CDN actually returned.
//
// Run it a few times during an incident (e.g. the daily 13:00-17:00 window):
//   node Test/wsprobe.mjs            # 20 rapid attempts
//   node Test/wsprobe.mjs 200        # 200 attempts

import https from "node:https";
import crypto from "node:crypto";

const WS_HOST = process.env.WS_HOST || "lavender-quail-935384.hostingersite.com";
const WS_PATH = process.env.WS_PATH || "/ws";
const ATTEMPTS = Math.max(1, Number(process.argv[2]) || 20);

function probe() {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = https.request({
      host: WS_HOST,
      port: 443,
      method: "GET",
      path: WS_PATH,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });

    let done = false;
    const finish = (summary) => {
      if (done) return;
      done = true;
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve(summary);
    };

    // A normal (non-101) HTTP response: 3xx redirects, 4xx, 5xx, etc.
    req.on("response", (res) => {
      const summary = {
        status: res.statusCode,
        location: res.headers.location || null,
        server: res.headers.server || null,
        requestId: res.headers["x-hcdn-request-id"] || null,
      };
      res.destroy();
      finish(summary);
    });

    // 101 Switching Protocols: the socket is upgraded, so Node fires "upgrade"
    // instead of "response".
    req.on("upgrade", (res, socket) => {
      const summary = {
        status: res.statusCode,
        location: res.headers.location || null,
        server: res.headers.server || null,
        requestId: res.headers["x-hcdn-request-id"] || null,
      };
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      finish(summary);
    });

    req.setTimeout(6000, () => finish({ status: "timeout", location: null }));
    req.on("error", (err) => finish({ status: "error", error: err.message }));
    req.end();
  });
}

const tally = new Map();
for (let i = 1; i <= ATTEMPTS; i++) {
  const r = await probe();
  const key = `${r.status}${r.location ? " -> " + r.location : ""}`;
  tally.set(key, (tally.get(key) || 0) + 1);
  console.log(
    `#${String(i).padStart(3)}  ${r.status}` +
      (r.location ? `  Location: ${r.location}` : "") +
      (r.server ? `  [server=${r.server}]` : "") +
      (r.requestId ? `  [req=${r.requestId}]` : "") +
      (r.error ? `  [err=${r.error}]` : "")
  );
}

console.log("\n--- summary ---");
for (const [k, n] of tally) console.log(`${String(n).padStart(4)} x ${k}`);