"use strict";
// Scans folder: OCR for scanned documents dropped into Desktop\Scans.
//
// On start the folder is created when missing and a listener is attached to
// it. Every new scan (image or PDF) is read with the OCR engine built into
// Windows (Windows.Media.Ocr) and the recognised text is logged.
//
// The engine is reached through a Windows PowerShell child process, so no npm
// dependency is needed. It can only read languages whose Windows OCR language
// pack is installed, so English, Turkish and Arabic are checked on start and
// the missing ones are installed (see ensureOcrLanguages).
//
// No Electron dependency (the folder, logger and OCR are injected), so the
// module can be tested with plain Node (see Test/scans.test.cjs).

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

// File types a scanner produces that Windows can decode.
export const SCAN_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".bmp",
  ".tif",
  ".tiff",
  ".pdf",
]);

// Languages every PC must be able to read: prefix -> pack installed when no
// pack of that language is present.
export const OCR_LANGUAGES = { en: "en-US", tr: "tr-TR", ar: "ar-SA" };

const OCR_TIMEOUT_MS = 5 * 60 * 1000;
// Downloading language packs from Windows Update can take several minutes.
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Runs in Windows PowerShell 5.1 (the WinRT projection is not in PowerShell 7).
// Input comes from environment variables, the answer is one line of JSON.
// The page is tried in all four rotations because the engine does not detect a
// sideways scan; the rotation with the most real words wins.
// No backticks in here: it is a JS template literal.
// ---------------------------------------------------------------------------
const OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Emit($obj) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Depth 6 -Compress)) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $installed = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  if ($env:SCAN_OCR_MODE -eq 'languages') { Emit @{ ok = $true; languages = $installed }; exit 0 }

  $ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
  $asOp = ($ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') })[0]
  $asAct = ($ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  function Await($op, $type) { $t = $asOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  function AwaitAction($op) { $t = $asAct.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }

  $engines = @()
  foreach ($prefix in $env:SCAN_OCR_LANGS.Split(',')) {
    $tag = $installed | Where-Object { $_.Split('-')[0] -eq $prefix } | Select-Object -First 1
    if ($tag) { $engines += @{ Tag = $tag; Engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag)) } }
  }
  if ($engines.Count -eq 0) { throw 'None of the required OCR languages is installed.' }

  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $nl = [string][char]10

  function Read-Frame($frame) {
    $long = [Math]::Max($frame.PixelWidth, $frame.PixelHeight)
    $best = $null
    foreach ($deg in 0, 90, 180, 270) {
      $tr = New-Object Windows.Graphics.Imaging.BitmapTransform
      $tr.Rotation = [Windows.Graphics.Imaging.BitmapRotation]($deg / 90)
      if ($long -gt $max) {
        $tr.ScaledWidth = [uint32][Math]::Floor($frame.PixelWidth * $max / $long)
        $tr.ScaledHeight = [uint32][Math]::Floor($frame.PixelHeight * $max / $long)
      }
      $bmp = Await ($frame.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tr, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $score = 0
      $texts = @()
      foreach ($e in $engines) {
        $r = Await ($e.Engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
        $s = 0
        $lines = @()
        foreach ($line in $r.Lines) {
          $lines += $line.Text
          foreach ($w in $line.Words) { if ($w.Text -match '^\p{L}{3,}$' -or $w.Text -match '^\p{Nd}{2,}$') { $s += $w.Text.Length } }
        }
        if ($s -gt $score) { $score = $s }
        $texts += @{ language = $e.Tag; text = ($lines -join $nl) }
      }
      $bmp.Dispose()
      if ($null -eq $best -or $score -gt $best.score) { $best = @{ rotation = $deg; score = $score; texts = $texts } }
    }
    $best
  }

  $path = $env:SCAN_OCR_FILE
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $pages = @()
  if ([IO.Path]::GetExtension($path) -eq '.pdf') {
    $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    for ($i = 0; $i -lt $pdf.PageCount; $i++) {
      $page = $pdf.GetPage($i)
      # Page sizes are in 1/96 inch: render at 300 dpi, within the engine limit.
      $scale = [Math]::Min(300 / 96, $max / [Math]::Max($page.Size.Width, $page.Size.Height))
      $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $opt.DestinationWidth = [uint32][Math]::Floor($page.Size.Width * $scale)
      $ms = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      AwaitAction ($page.RenderToStreamAsync($ms, $opt))
      $ms.Seek(0)
      $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ms)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $pages += (Read-Frame (Await ($dec.GetFrameAsync(0)) ([Windows.Graphics.Imaging.BitmapFrame])))
      $ms.Dispose()
      $page.Dispose()
    }
  } else {
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    for ($i = 0; $i -lt $dec.FrameCount; $i++) {
      $pages += (Read-Frame (Await ($dec.GetFrameAsync($i)) ([Windows.Graphics.Imaging.BitmapFrame])))
    }
    $stream.Dispose()
  }
  Emit @{ ok = $true; pages = $pages }
} catch {
  $inner = $_.Exception
  while ($inner.InnerException) { $inner = $inner.InnerException }
  Emit @{ ok = $false; error = [string]$inner.Message }
}
`;


// Installs the missing packs. Runs elevated (Windows asks for permission):
// Windows capabilities cannot be added from a normal user session. The Basic
// pack of a language has to be present before its OCR pack.
const INSTALL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$failed = 0
foreach ($tag in '__TAGS__'.Split(',')) {
  foreach ($kind in 'Basic', 'OCR') {
    try {
      $name = 'Language.' + $kind + '~~~' + $tag + '~0.0.1.0'
      $cap = Get-WindowsCapability -Online -Name $name
      if ($cap.State -ne 'Installed') { $null = Add-WindowsCapability -Online -Name $name }
    } catch { $failed++ }
  }
}
exit $failed
`;

// Starts the elevated installer and waits for it. Exit code 0 = all installed.
const ELEVATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $env:SCAN_OCR_INSTALL)
  exit $p.ExitCode
} catch {
  [Console]::Error.WriteLine([string]$_.Exception.Message)
  exit 1223
}
`;

function powershellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// -EncodedCommand takes UTF-16LE base64: no quoting problems, no script file.
const encode = (script) => Buffer.from(script, "utf16le").toString("base64");

function runPowerShell(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)],
      { env: { ...process.env, ...env }, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// The script answers with one JSON line; anything else is a failure.
async function runOcrScript(env) {
  const { code, stdout, stderr } = await runPowerShell(OCR_SCRIPT, env, OCR_TIMEOUT_MS);
  const line = stdout.trim().split(/\r?\n/).pop() || "";
  let answer;
  try {
    answer = JSON.parse(line);
  } catch {
    throw new Error(`OCR gave no answer (exit ${code}): ${stderr.trim() || line}`);
  }
  if (!answer.ok) throw new Error(answer.error || "OCR failed");
  return answer;
}

// OCR language packs installed on this PC, e.g. ["en-US", "tr-TR"].
export async function listOcrLanguages() {
  const answer = await runOcrScript({ SCAN_OCR_MODE: "languages" });
  return [].concat(answer.languages || []);
}

// Required languages (see OCR_LANGUAGES) that have no pack on this PC.
export function missingOcrLanguages(installed) {
  const have = new Set(installed.map((tag) => String(tag).split("-")[0].toLowerCase()));
  return Object.keys(OCR_LANGUAGES).filter((prefix) => !have.has(prefix));
}

// Read one scan. Resolves with [{ rotation, score, texts: [{ language, text }] }],
// one entry per page.
export async function recognizeFile(file) {
  const answer = await runOcrScript({
    SCAN_OCR_MODE: "ocr",
    SCAN_OCR_FILE: file,
    SCAN_OCR_LANGS: Object.keys(OCR_LANGUAGES).join(","),
  });
  return [].concat(answer.pages || []).map((page) => ({
    rotation: page.rotation,
    score: page.score,
    texts: [].concat(page.texts || []),
  }));
}

// Install OCR language packs (e.g. ["tr-TR", "ar-SA"]). Windows shows its
// permission prompt; resolves with true when every pack was installed.
export async function installOcrLanguages(tags) {
  const safe = tags.filter((tag) => /^[a-z]{2}-[A-Z]{2}$/.test(tag));
  if (safe.length === 0) return true;
  const install = INSTALL_SCRIPT.replace("__TAGS__", safe.join(","));
  const { code, stderr } = await runPowerShell(
    ELEVATE_SCRIPT,
    { SCAN_OCR_INSTALL: encode(install) },
    INSTALL_TIMEOUT_MS
  );
  if (code !== 0 && stderr.trim()) throw new Error(stderr.trim());
  return code === 0;
}

// Make sure English, Turkish and Arabic can be read: install what is missing
// and report what is still missing afterwards.
export async function ensureOcrLanguages({
  log = console,
  list = listOcrLanguages,
  install = installOcrLanguages,
} = {}) {
  let installed = await list();
  let missing = missingOcrLanguages(installed);
  if (missing.length === 0) {
    log.log(`[Scans] OCR languages ready: ${installed.join(", ")}`);
    return { installed, missing };
  }

  const tags = missing.map((prefix) => OCR_LANGUAGES[prefix]);
  log.log(`[Scans] Installing missing OCR language packs: ${tags.join(", ")}`);
  try {
    await install(tags);
  } catch (err) {
    log.error("[Scans] OCR language packs were not installed:", err);
  }

  installed = await list();
  missing = missingOcrLanguages(installed);
  if (missing.length === 0) {
    log.log(`[Scans] OCR languages ready: ${installed.join(", ")}`);
  } else {
    log.error(
      `[Scans] OCR language packs still missing: ${missing
        .map((prefix) => OCR_LANGUAGES[prefix])
        .join(", ")}. Scans are read with: ${installed.join(", ") || "nothing"}`
    );
  }
  return { installed, missing };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Watches the Scans folder and runs OCR on every scan that appears in it.
export class ScanWatcher {
  constructor({ dir, recognize = recognizeFile, log = console, settleMs = 1000 }) {
    this.dir = dir;
    this.recognize = recognize;
    this.log = log;
    // A scan counts as complete once its size held steady for this long.
    this.settleMs = settleMs;
    this.settleTimeoutMs = 2 * 60 * 1000;
    this.watcher = null;
    this.seen = new Map(); // file name -> "size:mtime" of the handled version
    this.pending = new Set(); // file names still being written
    this.queue = Promise.resolve(); // OCR runs one scan at a time
    this.stopped = true;
  }

  // Create the folder when it is missing and attach the listener. Files that
  // are already in the folder are not read: only new scans are.
  start() {
    const created = !fs.existsSync(this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.log.log(
      `[Scans] ${created ? "Created" : "Found"} the scans folder: ${this.dir}`
    );
    this.stopped = false;
    for (const name of this.list()) {
      const sig = this.signature(name);
      if (sig) this.seen.set(name, sig);
    }
    this.watcher = fs.watch(this.dir, () => this.scan());
    this.watcher.on("error", (err) => {
      this.log.error("[Scans] The folder listener failed:", err);
    });
    return created;
  }

  stop() {
    this.stopped = true;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  // Scans (by file type) currently in the folder.
  list() {
    try {
      return fs
        .readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isFile() && SCAN_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
        .map((e) => e.name);
    } catch (err) {
      this.log.error("[Scans] Failed to list the scans folder:", err);
      return [];
    }
  }

  signature(name) {
    try {
      const stat = fs.statSync(path.join(this.dir, name));
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null; // gone, or still locked by the scanner
    }
  }

  scan() {
    if (this.stopped) return;
    const names = this.list();
    for (const name of this.seen.keys()) {
      if (!names.includes(name)) this.seen.delete(name);
    }
    for (const name of names) {
      if (this.pending.has(name)) continue;
      const sig = this.signature(name);
      if (sig && this.seen.get(name) === sig) continue;
      this.pending.add(name);
      this.settle(name);
    }
  }

  // A scanner writes a file in pieces: wait until its size and time stop
  // changing, then queue it for OCR.
  async settle(name) {
    const started = Date.now();
    let last = null;
    try {
      while (!this.stopped && Date.now() - started < this.settleTimeoutMs) {
        await sleep(this.settleMs);
        const sig = this.signature(name);
        if (sig === null) {
          if (!fs.existsSync(path.join(this.dir, name))) return; // removed
          continue; // still locked
        }
        if (sig === last && !sig.startsWith("0:")) {
          this.seen.set(name, sig);
          this.queue = this.queue.then(() => this.process(name));
          return;
        }
        last = sig;
      }
      if (!this.stopped) this.log.error(`[Scans] "${name}" never finished writing.`);
    } finally {
      this.pending.delete(name);
    }
  }

  async process(name) {
    if (this.stopped) return;
    const file = path.join(this.dir, name);
    this.log.log(`[Scans] New scan: ${name}`);
    try {
      const pages = await this.recognize(file);
      pages.forEach((page, index) => {
        this.log.log(
          `[Scans] ${name} - page ${index + 1} of ${pages.length} (rotated ${page.rotation} degrees)`
        );
        for (const { language, text } of page.texts) {
          this.log.log(`[Scans] --- ${language} ---\n${text || "(no text found)"}`);
        }
      });
    } catch (err) {
      this.log.error(`[Scans] OCR failed for "${name}":`, err);
    }
  }
}

