-- Migration: Client diagnostics (failed requests captured on the PCs)
-- Description: Some clients intermittently receive HTTP 403 answers that never
--              reach InsuranceServer (a CDN/WAF/antivirus/proxy in front of the
--              API). Those answers carry the evidence - response headers, the
--              body of the block page and `x-hcdn-request-id` - but only on the
--              affected PC, which may be unable to reach the server at all while
--              the incident lasts.
--
--              Every client therefore records its failed requests (403 first,
--              plus network failures) and the FIRST successful request after a
--              403, keeps them in userData/diag/pending.jsonl, and uploads them
--              to POST /diag/client as soon as it can reach the API again.
--
--              This table is that inbox. Rows are NEVER pruned automatically:
--              they stay until an admin deletes them from the Diagnostics tab
--              (GET/DELETE /admin/diagnostics), so an incident can be inspected
--              days later. `UploadHeaders`/`ForwardedFor`/`UploadIp` preserve how
--              the upload itself looked to the server, which is what shows
--              whether X-Forwarded-For or the origin was rewritten in transit.
--
--              JSON columns hold the client's response headers, request headers,
--              environment snapshot and the extra per-report context.
-- Date: 2026-11-16

CREATE TABLE IF NOT EXISTS client_diagnostics (
  id BIGINT NOT NULL AUTO_INCREMENT,
  ReceivedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ClientId VARCHAR(80) NULL,
  Username VARCHAR(45) NULL,
  AuthState VARCHAR(8) NULL,
  Kind VARCHAR(24) NOT NULL DEFAULT 'failure',
  Status INT NULL,
  Method VARCHAR(12) NULL,
  Path VARCHAR(700) NULL,
  Url VARCHAR(1500) NULL,
  RequestId VARCHAR(80) NULL,
  HasRequestId TINYINT(1) NOT NULL DEFAULT 0,
  CapturedAt DATETIME NULL,
  CapturedAtMs BIGINT NULL,
  CapturedAtText VARCHAR(40) NULL,
  DurationMs INT NULL,
  Attempt INT NULL,
  RepeatCount INT NOT NULL DEFAULT 1,
  PairId VARCHAR(80) NULL,
  SamePath TINYINT(1) NULL,
  Origin VARCHAR(300) NULL,
  UploadIp VARCHAR(64) NULL,
  ForwardedFor VARCHAR(512) NULL,
  UserAgent VARCHAR(512) NULL,
  Body MEDIUMTEXT NULL,
  Headers JSON NULL,
  RequestHeaders JSON NULL,
  Env JSON NULL,
  Extra JSON NULL,
  UploadHeaders JSON NULL,
  UploadOrigin VARCHAR(300) NULL,
  PRIMARY KEY (id),
  KEY idx_client_diagnostics_received (ReceivedAt),
  KEY idx_client_diagnostics_client (ClientId),
  KEY idx_client_diagnostics_status (Status),
  KEY idx_client_diagnostics_kind (Kind),
  KEY idx_client_diagnostics_request (RequestId),
  KEY idx_client_diagnostics_ip (UploadIp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Verify:
--   SELECT Status, COUNT(*) AS n FROM client_diagnostics GROUP BY Status;
--   SELECT COUNT(*) AS n FROM client_diagnostics WHERE HasRequestId = 1;
