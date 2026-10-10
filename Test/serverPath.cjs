"use strict";

// Location of the InsuranceServer repository, whose REAL files the server-side
// tests load. There is deliberately no copy of the server inside this repo:
// tests always run against the server code that actually gets deployed.
//
// Default: the sibling checkout ../InsuranceServer (next to this repo).
// Override with the INSURANCE_SERVER_DIR environment variable.

const fs = require("fs");
const path = require("path");

const SERVER_DIR = path.resolve(
  process.env.INSURANCE_SERVER_DIR ||
    path.join(__dirname, "..", "..", "InsuranceServer")
);

/**
 * Absolute path of a file inside the InsuranceServer repo, e.g.
 * serverFile("Requests", "Brokers.js"). Exits with a clear message when the
 * server repo is not found, instead of failing with a confusing ENOENT.
 */
function serverFile(...parts) {
  const file = path.join(SERVER_DIR, ...parts);
  if (!fs.existsSync(file)) {
    console.error(
      `Server file not found: ${file}\n` +
        "The server-side tests load the real InsuranceServer code. Check out " +
        "the InsuranceServer repo next to this one, or set INSURANCE_SERVER_DIR."
    );
    process.exit(1);
  }
  return file;
}

module.exports = { SERVER_DIR, serverFile };
