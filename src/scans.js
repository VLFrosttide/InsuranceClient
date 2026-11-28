"use strict";
// Scans folder: OCR for scanned documents dropped into Desktop\Scans.
//
// On start the folder is created when missing and a listener is attached to
// it. Every new scan (image or PDF) is read with the OCR engine built into
// Windows (Windows.Media.Ocr). The recognised text is logged and saved to
// OCRScans.txt next to the folder: each scan replaces the text of the one
// before it, so the file always holds the latest scan.
//
// The forms these scans carry print every field as a code and a name - "(D.1)
// MARKASI" - with the data in the box below it (or beside it, in a wide box).
// The saved text follows that: one line per field, the label, a tab, then the
// data. Data is centred in its box, so where it starts says nothing; it is tied
// to the label above it instead (see fieldRows).
//
// The page is not turned to find the text: scans arrive upright. A phone photo
// keeps its rotation in EXIF, though, and stores the pixels sideways, so that
// quarter turn is applied before the page is read. A small page is read at twice
// its pixel size, where the print is only 15-25 px high.
//
// The engine is reached through a Windows PowerShell child process, so no npm
// dependency is needed. Every scan is Turkish, so the Turkish engine is the
// only one used; it can only read languages whose Windows OCR language pack is
// installed, so the Turkish pack is checked on start and installed when missing
// (see ensureOcrLanguages).
//
// No Electron dependency (the folder, logger and OCR are injected), so the
// module can be tested with plain Node (see test/client/scans.test.cjs).

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

// The languages scans are read in, prefix -> pack. Every scanned document is
// Turkish, so Turkish is the only one. Add another entry here only if scans in
// that language must be read too.
export const OCR_LANGUAGES = { tr: "tr-TR" };

const OCR_TIMEOUT_MS = 5 * 60 * 1000;
// Downloading language packs from Windows Update can take several minutes.
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Runs in Windows PowerShell 5.1 (the WinRT projection is not in PowerShell 7).
// Input comes from environment variables, the answer is one line of JSON.
// No backticks in here: it is a JS template literal.
// ---------------------------------------------------------------------------
const OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Emit($obj) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Depth 10 -Compress)) }
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
  # The print of a small photo of a form is only 15-25 px high and the engine
  # misreads it, so a small page is read at twice its pixel size. A page that is
  # already large is read as it is: doubling it there only adds specks. Pages too
  # large for the engine are scaled down.
  $READ_LONG = 2000
  $READ_SCALE = 2

  # The quarter turn of the page: a phone photo keeps its rotation in EXIF and
  # stores the pixels sideways. Mirrored photos are rare and read as they are.
  # The orientation is read with System.Drawing: the WinRT property bag is
  # awkward to read from PowerShell.
  function Frame-Rotation($path) {
    $orientation = 1
    try {
      Add-Type -AssemblyName System.Drawing
      $image = [System.Drawing.Image]::FromFile($path)
      try { $orientation = [int]$image.GetPropertyItem(274).Value[0] } catch { }
      $image.Dispose()
    } catch { }
    if ($orientation -eq 3) { return [Windows.Graphics.Imaging.BitmapRotation]::Clockwise180Degrees }
    if ($orientation -eq 6) { return [Windows.Graphics.Imaging.BitmapRotation]::Clockwise90Degrees }
    if ($orientation -eq 8) { return [Windows.Graphics.Imaging.BitmapRotation]::Clockwise270Degrees }
    return [Windows.Graphics.Imaging.BitmapRotation]::None
  }

  function Read-Frame($frame, $rotation) {
    $long = [Math]::Max($frame.PixelWidth, $frame.PixelHeight)
    $scale = 1
    if ($long -lt $READ_LONG) { $scale = $READ_SCALE }
    if ($long * $scale -gt $max) { $scale = $max / $long }
    $tr = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tr.Rotation = $rotation
    $tr.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    if ($scale -ne 1) {
      $tr.ScaledWidth = [uint32][Math]::Round($frame.PixelWidth * $scale)
      $tr.ScaledHeight = [uint32][Math]::Round($frame.PixelHeight * $scale)
    }
    $bmp = Await ($frame.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tr, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $texts = @()
    foreach ($e in $engines) {
      $r = Await ($e.Engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($line in $r.Lines) {
        # Every word keeps its rectangle: the caller rebuilds the printed rows
        # and boxes from them (the engine only reports reading order).
        $words = @()
        foreach ($w in $line.Words) {
          $box = $w.BoundingRect
          $words += @{ t = $w.Text; x = [Math]::Round($box.X, 1); y = [Math]::Round($box.Y, 1); w = [Math]::Round($box.Width, 1); h = [Math]::Round($box.Height, 1) }
        }
        $lines += @{ text = $line.Text; words = $words }
      }
      $texts += @{ language = $e.Tag; text = (($lines | ForEach-Object { $_.text }) -join $nl); lines = $lines }
    }
    $bmp.Dispose()
    @{ texts = $texts }
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
      $pages += (Read-Frame (Await ($dec.GetFrameAsync(0)) ([Windows.Graphics.Imaging.BitmapFrame])) ([Windows.Graphics.Imaging.BitmapRotation]::None))
      $ms.Dispose()
      $page.Dispose()
    }
  } else {
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    # A photo of several pages (a TIFF) is turned once, from its first frame.
    $rotation = Frame-Rotation $path
    for ($i = 0; $i -lt $dec.FrameCount; $i++) {
      $pages += (Read-Frame (Await ($dec.GetFrameAsync($i)) ([Windows.Graphics.Imaging.BitmapFrame])) $rotation)
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

// Read one scan. Resolves with one entry per page:
//   { texts: [{ language, text,
//               lines: [{ text, words: [{ text, x, y, width, height }] }] }] }
export async function recognizeFile(file) {
  const answer = await runOcrScript({
    SCAN_OCR_MODE: "ocr",
    SCAN_OCR_FILE: file,
    SCAN_OCR_LANGS: Object.keys(OCR_LANGUAGES).join(","),
  });
  return [].concat(answer.pages || []).map((page) => ({
    texts: [].concat(page.texts || []).map((entry) => ({
      language: entry.language,
      text: entry.text || "",
      lines: [].concat(entry.lines || []).map((line) => ({
        text: line.text || "",
        words: [].concat(line.words || []).map((word) => ({
          text: word.t || "",
          x: Number(word.x) || 0,
          y: Number(word.y) || 0,
          width: Number(word.w) || 0,
          height: Number(word.h) || 0,
        })),
      })),
    })),
  }));
}

// Install OCR language packs (e.g. ["tr-TR"]). Windows shows its permission
// prompt; resolves with true when every pack was installed.
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

// Make sure Turkish can be read: install the pack when it is missing and report
// what is still missing afterwards.
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

// ---------------------------------------------------------------------------
// Box layout
// ---------------------------------------------------------------------------
// The documents are forms: every value sits in a printed box. The engine only
// reports reading order, but it gives every word its rectangle, so the words are
// grouped into the cells of the printed boxes: a word joins the cell beside it
// while the gap is narrower than a box border. A wide gap starts a new cell.
const ROW_OVERLAP = 0.5; // share of the smaller word height two words must share
const CELL_GAP = 1.2; // word gap, in line heights, that counts as a box edge
export const CELL_SEPARATOR = "\t";

const median = (values) => {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Words -> the printed cells of the page, in reading order. A word joins the
// cell on its left while the gap is narrower than a printed border and both sit
// on one printed line; a wider gap starts the next cell. `row` counts the
// printed lines of the page: the cells of one line share it.
function pageCells(lines, { cellGap = CELL_GAP } = {}) {
  const words = [];
  for (const line of lines || []) {
    for (const word of line.words || []) {
      if (word.text) words.push(word);
    }
  }
  const lineHeight = median(words.map((word) => word.height));
  if (words.length === 0 || lineHeight === 0) return { cells: [], lineHeight: 0 };
  const gapWidth = cellGap * lineHeight;

  // The words are taken left to right. A word joins a cell when it touches the
  // cell's last word - the gap is narrower than a printed border and both sit on
  // one printed line. Taking them by x keeps a cell on one line: it is always
  // the next word across that is offered, never a word from the row below.
  const cells = [];
  for (const word of [...words].sort((a, b) => a.x - b.x || a.y - b.y)) {
    let cell = null;
    let nearest = Infinity;
    for (const open of cells) {
      const gap = word.x - open.right;
      if (gap > gapWidth || gap < -gapWidth) continue;
      const last = open.words[open.words.length - 1];
      const overlap =
        Math.min(last.y + last.height, word.y + word.height) - Math.max(last.y, word.y);
      if (overlap < ROW_OVERLAP * Math.min(last.height, word.height)) continue;
      if (gap < nearest) {
        nearest = gap;
        cell = open;
      }
    }
    if (!cell) {
      cell = { words: [] };
      cells.push(cell);
    }
    cell.words.push(word);
    cell.x = Math.min(cell.x === undefined ? word.x : cell.x, word.x);
    cell.right = Math.max(cell.right || 0, word.x + word.width);
    cell.top = Math.min(cell.top === undefined ? word.y : cell.top, word.y);
    cell.bottom = Math.max(cell.bottom || 0, word.y + word.height);
  }

  // The cells of one printed line are a row: a cell joins the row before it
  // while it sits on the line of that row's first cell. (The first cell, not the
  // row as it has grown: a tall cell would otherwise pull the rows below it in.)
  const rows = [];
  for (const cell of [...cells].sort((a, b) => a.top - b.top || a.x - b.x)) {
    const row = rows[rows.length - 1];
    const overlap = row ? Math.min(row.bottom, cell.bottom) - Math.max(row.top, cell.top) : 0;
    if (row && overlap >= ROW_OVERLAP * Math.min(row.bottom - row.top, cell.bottom - cell.top)) {
      cell.row = row.id;
      continue;
    }
    cell.row = rows.length + 1;
    rows.push({ id: cell.row, top: cell.top, bottom: cell.bottom });
  }

  return {
    cells: cells
      .sort((a, b) => a.row - b.row || a.x - b.x)
      .map((cell) => ({
        text: [...cell.words]
          .sort((a, b) => a.x - b.x)
          .map((word) => word.text)
          .join(" "),
        row: cell.row,
        x: cell.x,
        right: cell.right,
        top: cell.top,
        bottom: cell.bottom,
      })),
    lineHeight,
  };
}

// The cells per row, e.g. [["(A) PLAKA", "34PJY807"]].
export function layoutRows(lines, options = {}) {
  const { cells } = pageCells(lines, options);
  const rows = [];
  let row = null;
  for (const cell of [...cells].sort((a, b) => a.row - b.row || a.x - b.x)) {
    if (!row || row.id !== cell.row) {
      row = { id: cell.row, cells: [] };
      rows.push(row);
    }
    row.cells.push(cell.text);
  }
  return rows.map((printed) => printed.cells);
}

// ---------------------------------------------------------------------------
// Field layout
// ---------------------------------------------------------------------------
// Every field of these forms is printed as a code and a name - "(D.1) MARKASI"
// - in the top left of its box, with the data in the box below it (or, in a
// wide box, on the same line to its right). The data is centred in its box, so
// where it starts says nothing about the field it belongs to: only the label
// above it does. So the label of a field is found first, then the other cells
// are tied to the closest label above them.
const FIELD_CODE = /^[(\[][^)\]]{0,12}[)\]]/; // "(A)", "(D.1)", "(Z.3.4)"
const LABEL_ANCHOR = 1.5; // a column's labels start within this many line heights
const INLINE_VALUE = 12; // data right of its label on the same line, same box
const SIDEWAYS = 0.25; // what a line height of sideways distance counts against

// A label starts at its printed code. The reader now and then puts a speck in
// front of the bracket (a feather read as ";" or "4,"), so the few characters
// before the bracket are not part of the label.
function codeText(text) {
  const start = text.search(/[(\[]/);
  return start > 0 && start <= 4 ? text.slice(start).trim() : text;
}

// Where the labels of the page start, left to right: the columns of the form.
// Grouped so that the small differences of one column ("(A)" at 128, "(D.1)" at
// 127) are one anchor.
function labelAnchors(cells, lineHeight) {
  const anchors = [];
  for (const x of cells.map((cell) => cell.x).sort((a, b) => a - b)) {
    const last = anchors[anchors.length - 1];
    if (last && x - last.sum / last.count <= LABEL_ANCHOR * lineHeight) {
      last.sum += x;
      last.count += 1;
    } else {
      anchors.push({ sum: x, count: 1 });
    }
  }
  return anchors.map((anchor) => anchor.sum / anchor.count);
}

// The label above a cell: the closest one in height, with the sideways distance
// counted for less (a column of labels is walked down, so the label of one row
// is closer sideways but a whole row further away).
function labelAbove(fields, cell) {
  let best = null;
  let bestScore = Infinity;
  for (const field of fields) {
    if (field.top >= cell.top) continue; // below the data it would label
    const down = Math.max(0, cell.top - field.bottom);
    const sideways = Math.max(0, Math.max(field.x - cell.right, cell.x - field.right));
    const score = down + SIDEWAYS * sideways;
    if (score < bestScore) {
      bestScore = score;
      best = field;
    }
  }
  return best;
}

// The fields of one page, in reading order: [[label, data], ...] with an entry
// per label - the data is everything printed in its box, joined by spaces - and
// a cell with no label above it left as a line of its own. Falls back to the
// printed rows when the page carries no field codes at all.
export function fieldRows(lines, options = {}) {
  const { cells, lineHeight } = pageCells(lines, options);
  if (cells.length === 0) return [];

  // A label is its printed code. The reader also mangles a code now and then
  // ("(C.1.2)AD1" can come back as "(C.ı.2jAD1"), so a cell opening with a
  // bracket at one of the anchors of the page is a label too.
  const anchors = labelAnchors(
    cells.filter((cell) => FIELD_CODE.test(codeText(cell.text))),
    lineHeight
  );
  if (anchors.length === 0) return layoutRows(lines, options);
  const isLabel = (cell) => {
    const text = codeText(cell.text);
    return (
      FIELD_CODE.test(text) ||
      (text.startsWith("(") &&
        anchors.some((anchor) => Math.abs(anchor - cell.x) <= LABEL_ANCHOR * lineHeight))
    );
  };

  const fields = [];
  const loose = [];
  let label = null; // the last label read, which the cells beside it belong to
  for (const cell of cells) {
    // pageCells reads the page row by row, left to right.
    if (isLabel(cell)) {
      label = {
        label: codeText(cell.text),
        row: cell.row,
        top: cell.top,
        bottom: cell.bottom,
        x: cell.x,
        right: cell.right,
        values: [],
      };
      fields.push(label);
      continue;
    }
    // The data belongs to the label above it. It is centred in its box, so the
    // column it starts in says nothing, but a label whose box reaches across
    // the data is the one above it.
    const above = labelAbove(fields, cell);
    if (above && Math.min(above.right, cell.right) - Math.max(above.x, cell.x) > 0) {
      above.values.push(cell.text);
      continue;
    }
    // Data printed to the right of its label, on the label's own line, is in the
    // same box while it is close by; anything to its left or further right is
    // another box.
    const sameLine =
      label &&
      label.row === cell.row &&
      Math.min(label.bottom, cell.bottom) - Math.max(label.top, cell.top) >=
        ROW_OVERLAP * Math.min(label.bottom - label.top, cell.bottom - cell.top);
    if (
      sameLine &&
      cell.x >= label.right &&
      cell.x - label.right <= INLINE_VALUE * lineHeight
    ) {
      label.values.push(cell.text);
      continue;
    }
    if (above) above.values.push(cell.text);
    else loose.push(cell);
  }

  const rows = fields.map((field) => ({
    top: field.top,
    x: field.x,
    cells: [field.label, field.values.join(" ")].filter(Boolean),
  }));
  for (const cell of loose) {
    rows.push({ top: cell.top, x: cell.x, cells: [cell.text] });
  }
  rows.sort((a, b) => a.top - b.top || a.x - b.x);
  return rows.map((row) => row.cells);
}

// The saved text of one page: one line per field - its label, a tab, its data -
// with a line per printed row when the page carries no field codes. Falls back
// to the engine's own text when no rectangles came back.
export function pageText(page) {
  const texts = (page && page.texts) || [];
  const engine = texts.find((entry) => entry.lines && entry.lines.length) || texts[0];
  if (!engine) return "";
  const rows = fieldRows(engine.lines);
  if (rows.length === 0) return (engine.text || "").trim();
  return rows.map((cells) => cells.join(CELL_SEPARATOR)).join("\n");
}

// Write via a temp file + rename so an interrupted save never leaves half the
// text behind. On Windows the rename can fail while an antivirus/indexer briefly
// holds the target; fall back to a direct write (same as ./outbox.js).
async function writeTextFile(file, text) {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, text, "utf8");
  try {
    await fs.promises.rename(tmp, file);
  } catch {
    await fs.promises.writeFile(file, text, "utf8");
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

// Watches the Scans folder and runs OCR on every scan that appears in it.
export class ScanWatcher {
  constructor({
    dir,
    recognize = recognizeFile,
    log = console,
    settleMs = 1000,
    outFile = path.join(path.dirname(dir), "OCRScans.txt"),
  }) {
    this.dir = dir;
    // Where the recognised text goes: next to the scans folder by default.
    this.outFile = outFile;
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
        this.log.log(`[Scans] ${name} - page ${index + 1} of ${pages.length}`);
        for (const { language, text } of page.texts) {
          this.log.log(`[Scans] --- ${language} ---\n${text || "(no text found)"}`);
        }
      });
      await this.save(pages);
    } catch (err) {
      // The text file keeps the previous scan: there is nothing to save.
      this.log.error(`[Scans] OCR failed for "${name}":`, err);
    }
  }

  // The recognised text of the latest scan replaces what the file held before.
  // A failed write is logged and leaves the previous text in place.
  async save(pages) {
    const text = pages
      .map((page) => pageText(page))
      .filter(Boolean)
      .join("\n\n");
    try {
      await writeTextFile(this.outFile, text);
      this.log.log(`[Scans] Saved the text to ${this.outFile}`);
    } catch (err) {
      this.log.error(`[Scans] Failed to save the text to ${this.outFile}:`, err);
    }
  }
}



