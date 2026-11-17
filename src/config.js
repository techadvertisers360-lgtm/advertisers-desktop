const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_API_BASE_URL = "https://advertisers360-backend-six.vercel.app/api";

function loadConfiguredApiBaseUrl() {
  // 1. Explicit environment variable always wins.
  if (process.env.HRMS_API_BASE_URL) {
    return process.env.HRMS_API_BASE_URL;
  }

  // 2. A config.json placed next to the .exe. electron-builder's portable
  // launcher sets PORTABLE_EXECUTABLE_DIR to the folder containing the
  // actual .exe file (not the ephemeral %TEMP% extraction dir it runs
  // from), so this is readable/editable and survives across runs without
  // needing a rebuild — this is the file to edit when moving to a
  // different backend (a LAN IP, a real production server, etc.).
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || __dirname;
  const configPath = path.join(exeDir, "config.json");

  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed.apiBaseUrl) return parsed.apiBaseUrl;
    }
  } catch (err) {
    console.error(`[config] failed to read ${configPath}:`, err.message);
  }

  // 3. Fall back to localhost for local development.
  return DEFAULT_API_BASE_URL;
}

const API_BASE_URL = loadConfiguredApiBaseUrl();
// Check-in/check-out itself happens through the web portal, not the agent,
// so the agent only learns about it by polling — there's no local "event"
// to react to instantly. Kept short so resync/update-push/uninstall signals
// are picked up within ~15s instead of minutes.
const ATTENDANCE_POLL_INTERVAL_MS = 15 * 1000;

// One screenshot every 5 minutes while checked in — see capture-scheduler.js.
const CAPTURE_INTERVAL_MS = 5 * 60 * 1000;

module.exports = { API_BASE_URL, ATTENDANCE_POLL_INTERVAL_MS, CAPTURE_INTERVAL_MS };
