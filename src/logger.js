const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const LOG_DIR = path.join(app.getPath("userData"), "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "agent.log");

function write(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.appendFileSync(LOG_FILE, stamped + "\n");
  } catch {
    // Logging must never crash the app.
  }
}

module.exports = { write, LOG_FILE };
