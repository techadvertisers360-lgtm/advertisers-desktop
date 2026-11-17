const path = require("node:path");
const { app, BrowserWindow, desktopCapturer, shell, systemPreferences } = require("electron");
const logger = require("./logger");

// macOS only: screenshots need the "Screen Recording" permission, which
// Apple only lets the user grant (no app, installer or MDM profile can
// switch it on silently). This module makes that one step as painless as
// possible so nobody has to explain it to employees:
//   1. touches the capture API once so macOS lists this app under
//      Screen Recording (and shows its own prompt the first time),
//   2. opens System Settings straight on the right page,
//   3. shows a small window saying exactly what to switch on,
//   4. watches for the permission and restarts the agent automatically once
//      it's granted (macOS only applies it after a restart) — the saved
//      session resumes on its own, so screenshots just start.

const SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const REPROMPT_AFTER_MS = 60 * 60 * 1000; // don't nag more than once an hour
const WATCH_INTERVAL_MS = 3000;

let window = null;
let watchTimer = null;
let lastPromptAt = 0;

function isMac() {
  return process.platform === "darwin";
}

function screenAccessStatus() {
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

function hasScreenPermission() {
  return !isMac() || screenAccessStatus() === "granted";
}

function startWatchingForGrant() {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    if (screenAccessStatus() === "granted") {
      clearInterval(watchTimer);
      watchTimer = null;
      logger.write("[mac-permissions] screen recording granted — restarting agent to apply it");
      app.relaunch();
      app.exit(0);
    }
  }, WATCH_INTERVAL_MS);
}

function showPermissionWindow() {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 420,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: "Advertisers360 Agent",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  window.setMenuBarVisibility(false);
  window.loadFile(path.join(__dirname, "renderer", "mac-permission.html"));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("x-apple.systempreferences:")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("closed", () => {
    window = null;
  });
}

// Returns true when screenshots can be taken right now. When they can't,
// starts the guided flow above (at most once an hour) and returns false so
// the caller skips this capture instead of uploading a blank image.
async function ensureScreenPermission() {
  if (hasScreenPermission()) return true;

  startWatchingForGrant();
  if (Date.now() - lastPromptAt < REPROMPT_AFTER_MS) return false;
  lastPromptAt = Date.now();

  logger.write(`[mac-permissions] screen recording not granted (status=${screenAccessStatus()}) — guiding user`);
  try {
    // Registers the app in the Screen Recording list / triggers macOS's prompt.
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  } catch {
    // ignore — the settings page below is the real path
  }
  shell.openExternal(SETTINGS_URL);
  showPermissionWindow();
  return false;
}

module.exports = { ensureScreenPermission, hasScreenPermission, SETTINGS_URL };
