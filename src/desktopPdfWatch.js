"use strict";
// Which Desktop PDFs belong to the insurance form that is open right now, and
// the order their paper copies are printed in.
//
// While a worker processes a policy, an external tool downloads the policy PDFs
// to the Desktop (see the Desktop PDF watcher in main.js). Everything else on
// the Desktop - policies from earlier visits, a plane ticket, a bank statement -
// must be left alone: never printed, never uploaded, never deleted. Only the
// files downloaded for THIS form are picked up.
//
// Two facts decide that together, because neither is reliable on its own:
//
//   1. A snapshot of the Desktop's PDFs, taken when the watch starts. A file
//      that is not in it was written after the form was opened, so it is ours.
//   2. The file's creation time, for the one case the snapshot cannot see - a
//      PDF downloaded in the gap between the worker's click and the form
//      finishing loading. It is already on the Desktop when the watch starts,
//      but it was created after the click.
//
// The creation time alone would not be enough: a downloader may keep the
// server's (older) timestamp, and a filesystem without a usable creation time
// reports the modification time instead. A fresh PDF can therefore look old,
// be skipped, and stay on the Desktop forever - the very leak this module is
// there to prevent.
//
// No Electron or fs access (the caller passes stat results), so the rules can be
// tested with plain Node (see test/client/desktopPdfWatch.test.cjs).

// Which downloaded PDF is the policy (the "BG_02_ FI<policy>.pdf" file) is the
// same rule pdfFields.js reads the policy number with; reusing it keeps the
// print order and the field reader from disagreeing about the files.
import { policyPdfName } from "./pdfFields.js";

// The moment a PDF was created, falling back to its modification time on
// filesystems that report no usable creation time (birthtime 0).
export function desktopPdfCreatedMs(stat) {
  if (!stat) return 0;
  const born = Number(stat.birthtimeMs);
  if (Number.isFinite(born) && born > 0) return born;
  return Number(stat.mtimeMs) || 0;
}

// Size + creation time of one PDF: the pair that tells "the same file" from
// "the same name, written again". A re-download keeps the name but changes one
// of them, and must be handled like a new file.
export function desktopPdfIdentity(stat) {
  return {
    size: stat && Number.isFinite(Number(stat.size)) ? Number(stat.size) : 0,
    createdMs: desktopPdfCreatedMs(stat),
  };
}

// True when this PDF has already been taken care of in this watch, i.e. the
// file at that path still has the size and creation time it had when it was
// handled. A different size or time means the name was written again.
export function desktopPdfAlreadyHandled(handled, identity) {
  if (!handled || !identity) return false;
  return handled.size === identity.size && handled.createdMs === identity.createdMs;
}

// True when this PDF may have been downloaded for the form that opened the
// watch, so it may be uploaded, printed and deleted:
//   - it was not on the Desktop when the watch started, or
//   - it was already there but has been written since (its size or creation
//     time no longer matches the snapshot), or
//   - it was already there unchanged, but was created after the form was
//     opened - a download that landed between the click and the form loading.
// A PDF that was on the Desktop before the click matches none of these and is
// never touched, however old it is.
export function desktopPdfBelongsToForm(watch, filePath, identity) {
  if (!watch || !identity) return false;
  const before = watch.existing ? watch.existing.get(filePath) : null;
  if (!before) return true;
  if (before.size !== identity.size || before.createdMs !== identity.createdMs) {
    return true;
  }
  return Number(identity.createdMs) >= Number(watch.sinceMs);
}

// The order the paper copies of one insurance are printed in: the policy
// ("BG_02_ FI<policy>.pdf") always first, the invoice/payment slip (the file
// named after the upload id) after it. The external tool downloads the two PDFs
// one after the other, in no guaranteed order, and the print queue prints a
// file as soon as it has both - so the caller sorts its jobs with this before
// handing them over, and the policy is the first sheet out of the printer
// whichever of the two was downloaded first.
//
// Jobs keep their relative order within each group (only the policy is moved to
// the front), so the remaining documents of a visit are never reordered.
// `policyPdfName` is the same rule pdfFields.js uses to read the policy number,
// so the two can never disagree about which file is the policy.
//
//   desktopPdfPrintOrder([{ filename: "8a15af00.pdf" }, { filename: "BG_02_ FI1.pdf" }])
//     -> [{ filename: "BG_02_ FI1.pdf" }, { filename: "8a15af00.pdf" }]
export function desktopPdfPrintOrder(jobs) {
  const policy = [];
  const others = [];
  for (const job of jobs || []) {
    if (job && policyPdfName(job.filename)) policy.push(job);
    else others.push(job);
  }
  return policy.concat(others);
}
