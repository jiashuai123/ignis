"use strict";

const { execFile } = require("child_process");

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const NETWORK_TIMEOUT_MS = 120 * 1000; // clone/push/pull can be slow

function run(vaultPath, args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // execFile with an args array: no shell, no injection surface.
    execFile(
      "git",
      ["-C", vaultPath, ...args],
      { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = (stderr || "").trim();
          err.stdout = (stdout || "").trim();
          reject(err);
        } else {
          resolve({ stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
        }
      },
    );
  });
}

async function available() {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

module.exports = { run, available, NETWORK_TIMEOUT_MS };
