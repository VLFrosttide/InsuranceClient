# Diagnoses PC-specific HTTP 403 errors when the Insurance client calls the API.
#
# Run on the affected PC (and, for comparison, on a working PC):
#   powershell -ExecutionPolicy Bypass -File diagnose-pc.ps1
# Optionally pass the real session token (DevTools console in the app:
#   localStorage.getItem("token")) to test authenticated requests:
#   powershell -ExecutionPolicy Bypass -File diagnose-pc.ps1 -Token <token>
#
# The report is printed and saved to insurance-diagnose.txt on the Desktop.
#
# How to read it: every protected route must answer with JSON from Express
# (X-Powered-By: Express) - 401 with a fake token, 200 with a valid one. An
# HTML 403 without X-Powered-By means the request was blocked before it reached
# the application (antivirus web filter, proxy, or the hosting firewall).

param([string]$Token = "diagnostic-invalid-token")

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Base = "https://lavender-quail-935384.hostingersite.com"
# "ГКПП Капитан Андреево", percent-encoded (keeps this file ASCII-only).
$Branch = "%D0%93%D0%9A%D0%9F%D0%9F%20%D0%9A%D0%B0%D0%BF%D0%B8%D1%82%D0%B0%D0%BD%20%D0%90%D0%BD%D0%B4%D1%80%D0%B5%D0%B5%D0%B2%D0%BE"
$Out = Join-Path ([Environment]::GetFolderPath("Desktop")) "insurance-diagnose.txt"
Remove-Item $Out -ErrorAction SilentlyContinue

function W([string]$s) {
  Write-Output $s
  Add-Content -Path $Out -Value $s -Encoding UTF8
}

W "=== $(Get-Date -Format s)  PC: $env:COMPUTERNAME  User: $env:USERNAME"

W "`n--- Public IP (compare with a working PC)"
try { W (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10) }
catch { W "failed: $($_.Exception.Message)" }

W "`n--- Proxy settings"
$ie = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
W "User (used by the app): ProxyEnable=$($ie.ProxyEnable) ProxyServer=$($ie.ProxyServer) AutoConfigURL=$($ie.AutoConfigURL)"
W ("WinHTTP: " + ((netsh winhttp show proxy) -join " ").Trim())
W "Env: HTTPS_PROXY=$env:HTTPS_PROXY HTTP_PROXY=$env:HTTP_PROXY"

W "`n--- Antivirus / security products"
try {
  Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop |
    ForEach-Object { W $_.displayName }
} catch { W "unavailable: $($_.Exception.Message)" }

W "`n--- TLS certificate issuer (an antivirus name here = HTTPS scanning is active)"
try {
  $req = [Net.HttpWebRequest]::Create("$Base/health")
  $req.Timeout = 15000
  try { $req.GetResponse().Close() } catch { }
  if ($req.ServicePoint.Certificate) { W $req.ServicePoint.Certificate.Issuer } else { W "no certificate captured" }
} catch { W "failed: $($_.Exception.Message)" }

W "`n--- API requests (Authorization: Bearer $(if ($Token -eq 'diagnostic-invalid-token') { 'fake token' } else { 'real token' }))"
$paths = @(
  "/health",
  "/worker",
  "/insurances?author=diagnostic",
  "/currentcash?branch=$Branch",
  "/totalcash?branch=$Branch",
  "/cardpayments",
  "/brokers",
  "/tariffs/my-pricing?branch=$Branch"
)
foreach ($p in $paths) {
  $status = 0; $headers = $null; $body = ""
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ($Base + $p) -TimeoutSec 20 `
      -Headers @{ Authorization = "Bearer $Token" }
    $status = [int]$r.StatusCode; $body = $r.Content
    $server = $r.Headers["Server"]; $xpb = $r.Headers["X-Powered-By"]
    $ctype = $r.Headers["Content-Type"]; $rid = $r.Headers["x-hcdn-request-id"]
  } catch {
    $resp = $_.Exception.Response
    if (-not $resp) { W ("{0,-45} NO RESPONSE: {1}" -f $p, $_.Exception.Message); continue }
    $status = [int]$resp.StatusCode
    $server = $resp.Headers["Server"]; $xpb = $resp.Headers["X-Powered-By"]
    $ctype = $resp.Headers["Content-Type"]; $rid = $resp.Headers["x-hcdn-request-id"]
    try { $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { }
  }
  $verdict = if ($xpb -eq "Express") { "reached app" } else { "NOT from app" }
  $short = ($body -replace "<style>[\s\S]*?</style>", "" -replace "<[^>]+>", " " -replace "\s+", " ").Trim()
  if ($short.Length -gt 120) { $short = $short.Substring(0, 120) }
  W ("{0,-45} {1}  [{2}] server={3} type={4} req-id={5}" -f $p.Split("?")[0], $status, $verdict, $server, $ctype, $rid)
  W ("{0,-45} body: {1}" -f "", $short)
}

W "`nSaved to $Out"
