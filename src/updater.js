const { autoUpdater } = require("electron-updater");
const { Notification } = require("electron");
const logger = require("./logger");

// A NEW UPDATE_CHECK_INTERVAL_MS interval per the "har kuch ghante mein"
// requirement — on top of the check that already happens once at app
// startup (see start() below).
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  // Download silently in the background the moment a new version is found
  // — no prompt to accept the download itself, only to restart once it's
  // actually ready (see update-downloaded below). Never auto-installs on
  // its own timer; only quitAndInstall() or a normal app quit applies it.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    logger.write(`[updater] error: ${err?.message ?? err}`);
  });

  autoUpdater.on("checking-for-update", () => {
    logger.write("[updater] checking for update");
  });

  autoUpdater.on("update-available", (info) => {
    logger.write(`[updater] update available: v${info.version} — downloading in background`);
  });

  autoUpdater.on("update-not-available", () => {
    logger.write("[updater] already on the latest version");
  });

  // Downloaded and verified, ready to apply. Doesn't force anything — the
  // notification is clickable for an immediate restart, and if it's never
  // clicked, autoInstallOnAppQuit above applies it the next time the app
  // closes/restarts normally (e.g. a PC reboot), so it can never be missed
  // for long even if no one is at the computer to see it.
  autoUpdater.on("update-downloaded", (info) => {
    logger.write(`[updater] update downloaded: v${info.version} — ready to install`);
    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title: "Advertisers360 Agent — update ready",
      body: `Version ${info.version} has been downloaded. Click to restart and update now, or it'll apply automatically next time you restart the app.`,
    });
    notification.on("click", () => autoUpdater.quitAndInstall());
    notification.show();
  });
}

// Returns "updated" | "already_current" | null (null = the check itself
// failed, e.g. offline — an unknown outcome, not a real answer either way).
// Used to report back to a manager-pushed update-check signal so the
// dashboard can show "X updated, Y already current" instead of a flat ack
// count. Compares the feed's version against this build's own version
// directly off checkForUpdates()'s return value, rather than tracking the
// update-available/update-not-available events globally — those fire for
// *any* concurrent check (the periodic timer and a pushed signal could
// overlap), so reading them back out isn't reliably tied to this specific
// call.
async function checkForUpdates() {
  init();
  try {
    const result = await autoUpdater.checkForUpdates();
    const latestVersion = result?.updateInfo?.version;
    const currentVersion = autoUpdater.currentVersion?.version;
    if (!latestVersion || !currentVersion) return null;
    return latestVersion !== currentVersion ? "updated" : "already_current";
  } catch (err) {
    logger.write(`[updater] checkForUpdates failed: ${err.message}`);
    return null;
  }
}

let intervalTimer = null;

function start() {
  init();
  checkForUpdates(); // once at app startup, per requirement #3
  if (!intervalTimer) {
    intervalTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  }
}

// How long checkAndApplyBlocking() will wait for a found update to finish
// downloading before giving up and letting login proceed on the current
// version. The installer is ~80MB — generous on purpose so a normal
// connection has a real chance to finish, but bounded so a slow/dead network
// at the exact moment of login can never hang the employee out of the app
// they're trying to open. If it times out, autoDownload continues in the
// background regardless (see init() above) and autoInstallOnAppQuit still
// applies it on some future restart, or the next login attempt tries again.
const UPDATE_APPLY_TIMEOUT_MS = 60 * 1000;

function waitForDownloadOutcome(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      autoUpdater.removeListener("update-downloaded", onDownloaded);
      autoUpdater.removeListener("error", onError);
      resolve(outcome);
    };
    const onDownloaded = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    autoUpdater.once("update-downloaded", onDownloaded);
    autoUpdater.once("error", onError);
  });
}

// Used at login time (both a fresh password login and a silently-resumed
// session) instead of the passive checkForUpdates() above: this one actually
// waits for the newer version to finish downloading and, if it does in time,
// installs it and restarts the app immediately — rather than leaving a
// downloaded update to sit applied-on-next-restart, possibly for days, while
// the employee keeps working on the exact build that has the bug. Calls
// `onUpdating()` only once it's confirmed there really is a newer version to
// install, so the caller can show a brief "Updating..." state instead of
// flashing it for every ordinary login where nothing needs to change.
// Returns true if quitAndInstall() was called (the process is exiting — the
// caller should not do anything else after this resolves true) or false if
// login should just proceed normally on the current version.
async function checkAndApplyBlocking({ onUpdating } = {}) {
  init();
  try {
    const result = await autoUpdater.checkForUpdates();
    const latestVersion = result?.updateInfo?.version;
    const currentVersion = autoUpdater.currentVersion?.version;
    if (!latestVersion || latestVersion === currentVersion) {
      return false;
    }

    logger.write(`[updater] v${latestVersion} found at login — waiting for it to finish downloading`);
    onUpdating?.();

    const downloaded = await waitForDownloadOutcome(UPDATE_APPLY_TIMEOUT_MS);
    if (!downloaded) {
      logger.write("[updater] download not finished in time — continuing login on current version");
      return false;
    }

    logger.write(`[updater] v${latestVersion} downloaded — installing and restarting now`);
    autoUpdater.quitAndInstall(true, true); // silent=true, relaunch after=true
    return true;
  } catch (err) {
    logger.write(`[updater] checkAndApplyBlocking failed: ${err.message}`);
    return false;
  }
}

module.exports = { start, checkForUpdates, checkAndApplyBlocking };
