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

## Findings from the 2026-11-16 export (`client-diagnostics-2026-11-16T19-40-25-569Z.json`)

33 reports, 3 clients: 16 `403`, 4 `recovery`, 12 `websocket-error`, 2 `network-error`
(client-side aborts of `/branches` after 8 s and `/ping` after 12 s, not server faults).

**The 403s are produced by the Hostinger CDN, not by InsuranceServer.** Every one of
them carries:

* `server: hcdn`, `content-type: text/html`, body = LiteSpeed's
  `<h1>403</h1><h2>Forbidden</h2><p>Access to this resource on the server is denied!</p>`
  page (787 bytes), request id `x-hcdn-request-id: …-fra-edge7|8`;
* **no** `x-powered-by: Express`, `platform: hostinger` or `panel: hpanel` — all three
  are present on every Express answer, including Express' own 404s (verified live
  against `/nope-not-a-route`), and `x-hcdn-cache-status`/`x-hcdn-upstream-rt` appear
  on every 200. So the request never reached the Node process;
* the server's own ring buffer for the same hour holds 120 requests and **zero 403s**;
  none of the failing `/ping`, `/branches`, `/logme` calls appear in it.

All 16 come from **one public IP, 130.204.76.194** (branch PC `DESKTOP-SU92BUV`,
user `DARIAANGELOVA`, proxy DIRECT, genuine `*.hostingersite.com` Let's Encrypt cert,
so no antivirus/proxy interception). Requests are refused in episodes of 10–65 s that
start roughly every five minutes (19:01, 19:05, 19:06, 19:11, 19:15, 19:21, 19:22 UTC),
and identical requests succeed seconds later:

| failure | recovery |
| --- | --- |
| `GET /ping` 403 at 19:06:23 | `GET /ping` 200 at 19:06:37 |
| `POST /logme` 403 at 19:05:34 | `POST /logme` 200 at 19:06:44 |
| `GET /ping` 403 at 19:11:45 | `GET /ping` 200 at 19:12:00 |
| `GET /ping` 403 at 19:15:01 (repeatCount 27) | `GET /ping` 200 at 19:20:16 |

Reproduced live on 2026-11-16 from another IP: 150 requests in 15 s, HTTP/1.1 and
HTTP/2, with `Origin: null`, `Origin: file://`, `Content-Type: application/json` on
GET, `Authorization: Bearer …` and the app's exact User-Agent, plus CORS preflights —
all `200`/`204` from Express (edges 6–10). So the block is **not** volume-, header-,
protocol- or auth-based; it is a per-source-IP CDN decision.

At the time of this report the API host was `lavender-quail-935384.hostingersite.com`
(the client now targets `bulsig.online`; the host is set in `config.js`).
That Hostinger preview hostname is a CNAME to
**`free.cdn.hstgr.net`**, i.e.
the whole API and WebSocket live behind Hostinger's CDN, whose default security level
is *Medium* (challenges visitors by threat score) and which has IP/country traffic
blocking. Hostinger documents exactly this case in *Hostinger CDN: How to fix blocked
legitimate requests*: lower the security level, review Traffic blocking, test with the
CDN disabled, and if it still happens send support the URL, method,
`x-hcdn-request-id`, timestamp and client IP so the triggered rule can be excepted.

### Fix (hosting side, no client release needed)

1. hPanel → Websites → *Manage site* → **Performance → CDN**: set the Security level
   to *Essentially off*/*Low* (Business plan or higher; if the plan has no level
   control, go to step 2), and review **Traffic blocking** for country/IP rules that
   cover Bulgaria or 130.204.76.194 (branch NAT).
2. Preferred for this workload: **disable the CDN for the API hostname**
   (`bulsig.online`) - or point the
   client at a hostname that is not behind it. A desktop client's authenticated JSON
   API and `wss://` upgrade gain nothing from the free CDN, and it is the layer that
   both answers 403 and interferes with the `Upgrade`.
3. If the CDN must stay, open a ticket with the 16 request ids below and ask for an
   exception for this endpoint/IP.

```
19:01:33.081 GET  /branches  e63a0d390662686198723c0131d854ca-fra-edge8
19:01:33.083 GET  /ping      f4e7b3a0955b7beb7ed41cfe5de34db3-fra-edge8
19:01:57.624 POST /logme     bfe828f660b16391a3696215df949577-fra-edge8
19:05:19.361 GET  /branches  659b2a07a2dd949dbe3a3e934322ef56-fra-edge7
19:05:19.363 GET  /ping      a2c4c67c9bde9904b9e824f3f6163844-fra-edge7
19:05:34.333 POST /logme     a4c507aa0531657be50e9ab44a3dbc3e-fra-edge7
19:06:23.417 GET  /ping      3635ebd9dbda5c6f3c971a086144a6dc-fra-edge7
19:06:23.434 GET  /branches  39d27563e27ee7e4f60d94b3d417d535-fra-edge7
19:11:45.618 GET  /ping      a50e263836a72b43a21d4cf837d63bbb-fra-edge7
19:11:45.623 GET  /branches  98295014c70fdbc7b7cf5c29e00b9fcc-fra-edge7
19:11:55.896 POST /logme     fa04825cbca9fdfdb7a59ff472e4fb1e-fra-edge7
19:15:01.215 GET  /ping      ca15b312bdd1028faff8eaf91ae2b32f-fra-edge8
19:15:01.217 GET  /branches  6c4a5ade44ad6fed2b54eb7e0ca9db13-fra-edge8
19:15:17.610 POST /logme     44560548643bf0a5ff8dcc02ccf8157f-fra-edge8
19:21:22.146 POST /logme     3d2d72797f1e9dd5a62070b8bf4e0612-fra-edge8
19:22:23.839 GET  /branches  9686e4ed3714be7acde319f61a764b3a-fra-edge7
```

### Known gap in the export

The 12 `websocket-error` reports say only `handshake failed (attempt n)`; the
`WsHandshakeProbe` result (status + `Location` + `server` + request id) exists only in
the console/log. Until it is stored in the report, a WebSocket incident cannot be
attributed (CDN challenge vs 307 vs client-side proxy) from an export.

## Database

`db/setup.js` creates `client_diagnostics` on every start (`CREATE TABLE IF NOT
EXISTS`), so no manual step is needed. `migrations/016_client_diagnostics.sql`
documents the same table. Rows are kept until an admin deletes them.

