# Diagnosing the intermittent 403s

## What a client records

`renderer/diag.js` wraps `window.fetch` on every page (it is loaded before
`common.js`). For every failed request - `403` first, but also 401/429/5xx,
HTML answers with a `200` (a CDN block page served with the wrong status) and
network-level failures - it stores:

| Field | Why it matters |
| --- | --- |
| exact timestamp (`capturedAt`, ISO, and `capturedAtMs`) | correlate with the server log and the CDN request id |
| method + full URL + path | which endpoint is refused |
| status / statusText | 403 vs 401 vs the CDN's own page |
| **all** response headers, lower-cased | `server: hcdn`, `x-powered-by: Express`, `via`, `cf-ray`, `content-type`, `www-authenticate`, `retry-after` |
| `x-hcdn-request-id` **and** `hasHcdnRequestId` | quote it to the host when the block is at the CDN |
| response body (up to 8 KB) + `<title>` | the block page names the blocker (hCDN WAF, ModSecurity, antivirus, captive portal) |
| request headers, with `Authorization`/`Cookie` replaced by `[redacted len=… fp=…]` | compare what the client sent with what the server received - **the token is never stored or uploaded** |
| duration, attempt number, repeat counter | distinguishes "one slow request" from a retry loop |
| environment: hostname, Windows user, public IP, resolved proxy, TLS certificate issuer, network interfaces, OS/Electron/Chrome versions, timezone, renderer locale, `navigator.connection`, screen, online flag, app version, stable per-install `clientId` | an IP-range rule, an antivirus proxy (issuer/proxy), or a broken TLS interception shows up here |
| requests in the last minute | "unusually frequent polling" |

The **first successful request after a 403** is recorded too (`kind:
"recovery"`), with the same fields and a `pairId` linking it to the failure, so
the two responses can be compared side by side.

Identical failures within two minutes are merged into one report with a
`repeatCount` (and the latest duration/attempt), so a retry storm cannot fill
the queue.

## Where it is stored and when it is uploaded

* Main process file: `%APPDATA%\Insurance\diag\pending.jsonl` (per-install
  `client-id.txt` next to it). It survives page changes, crashes and restarts.
* Cap: 200 entries / 4 MB; oldest reports are dropped first.
* Upload: `POST /diag/client` with the session token when there is one. A
  client that cannot log in has no token, so reports captured **without** a
  token (failed logins) may be uploaded anonymously; reports captured while
  signed in wait for a login. The upload is attempted on page load (after 4 s),
  after any successful request, every 60 s while reports remain, and on
  `online`. 429/401 answers are honoured (backoff / wait for a new session).
* The upload itself is not recorded (it uses the saved original `fetch`), so
  there is no feedback loop.
* A WebSocket upgrade failure (403/3xx before `101`) is recorded as
  `kind: "websocket-error"`; the browser hides the HTTP status there.

## Reading it in the app

Admin dashboard -> **Diagnostics**:

* summary: stored reports, 403s, recoveries, reports carrying a request id,
  number of clients;
* per-report table (403 rows tinted red); click a row for the full JSON -
  headers, body, environment, redacted request headers - and a copy button;
* **How the server sees a request**: the IP the server resolved and from which
  header (`X-Forwarded-For`, `X-Real-IP`, socket), the CORS/auth policy, the
  Express `trust proxy` setting, the busiest IP/path in the last minute, and
  the server's own last failures;
* **Local queue on this PC**: how many reports this PC still has to upload, and
  an *Upload now* button;
* *Download JSON* exports everything shown (reports + server context); *Delete
  all* is the only thing that removes stored reports - nothing is pruned
  automatically.

Useful interpretation:

* `403` + `x-powered-by: Express` + JSON `{"error": ...}`: the application
  rejected it (role/account). The JSON error names the reason.
* `403` **without** `x-powered-by` and an HTML body: rejected before Express -
  CDN/WAF, antivirus web filter or proxy. Compare `x-hcdn-request-id`,
  `server`, the body title and the client's public IP/proxy/TLS issuer across a
  failing and a working PC.
* A failure and its `recovery` with the same `pairId` but different headers or
  a different source IP show what changed (session, network path, time window).


## Access-control audit (what can reject a request today)

Checked in `InsuranceServer` and the client:

| Area | Current behaviour |
| --- | --- |
| **IP ranges** | No route filters by IP. No allow/deny list anywhere. Only the CDN/hosting firewall can do this (outside this repo) - the client report's `publicIp`, `networkInterfaces` and the server context's `request.ip` / `X-Forwarded-For` are the evidence. |
| **X-Forwarded-For** | Used only for logging (`clientIp()` in `main.js`, left-most forwarded value). Nothing authorises or rate-limits by it. `app.set("trust proxy", ...)` is **not** set, so Express' own `req.ip` is the CDN/proxy address - any future IP logic must use `clientIp()`, not `req.ip`. The diagnostics context reports the raw header chain plus `trustProxy`. |
| **Authentication headers** | `Authorization: Bearer <token>` or the `token` cookie. `401` = missing/invalid/expired token; `403` = valid token but the account is `deleted`/`suspended`, or `requireRole` refuses the role. The client only clears the session on `401`, so a `403` never logs a worker out. `POST /logme` answers `403` for a deleted/suspended/pending account, a disabled branch, or an unknown role. |
| **Rate limits** | None on the API routes. The only limiter is the new diagnostics intake (30 anonymous / 120 authenticated uploads per 10 min per client, keyed by IP + client id). A CDN-side rate rule is invisible to the app - which is why the burst/`repeatCount`/`attempt` fields and the server-side `/min` table exist. |
| **Request origin** | No origin allow-list. The API answers `Access-Control-Allow-Origin: *` and accepts `Content-Type, Authorization`; `OPTIONS` returns 204. The Electron client sends `Origin: file://`. A CDN/WAF rule on `Origin`/`Referer` is visible by comparing the captured request headers with `UploadHeaders`/`UploadOrigin` recorded by the server. |
| **Polling / retries** | Login page probes `GET /ping` every 15 s (4/min per open login screen). The dashboard keeps one WebSocket per user (ping every 20 s; presence every 15 s) - not HTTP. `api()` retries idempotent requests up to 3 times with 0.8 s/1.6 s backoff on 429/5xx/network errors; `loginFetch()` retries up to 3 times with 1.5 s/3 s backoff, each attempt up to 30 s, so a blocked login can produce 3 `POST /logme` in ~90 s. Every report carries `attempt`, `repeatCount` and `requestsLastMinute`; the server keeps a per-IP+path one-minute counter (visible in the Diagnostics tab) so a WAF-style "too many requests" rule can be confirmed or ruled out. |

The single most useful comparison is: **a client report whose path never
appears in the server's recent requests was blocked before the application**
(the request id then belongs to the CDN, not to Express).

## Database

`db/setup.js` creates `client_diagnostics` on every start (`CREATE TABLE IF NOT
EXISTS`), so no manual step is needed. `migrations/016_client_diagnostics.sql`
documents the same table. Rows are kept until an admin deletes them.

