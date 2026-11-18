const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const apiClient = require("./api-client");
const session = require("./session");
const updater = require("./updater");
const captureScheduler = require("./capture-scheduler");
const { withAuth, forceRefresh, SESSION_UNAVAILABLE } = require("./session-refresh");
const { ATTENDANCE_POLL_INTERVAL_MS } = require("./config");
const logger = require("./logger");

let timer = null;
// The last request id of each signal type this agent has already acted on
// — tracked independently (not just "the latest overall") since a resync
// and an update-push are unrelated signals that can arrive interleaved; see
// backend/src/models/agent.model.js for the same reasoning server-side.
// In-memory only (not persisted to disk) is fine: re-acting after an app
// restart is harmless, since restarting either cycle is idempotent.
let lastActedResyncId = null;
let lastActedUpdateCheckId = null;

// Set by main.js — actually performing the uninstall (clearing the local
// session, then handing off to self-uninstall.js) needs main.js's own
// app-lifecycle state (windows, tray), so this module only ever detects the
// signal and hands control back up rather than trying to do that itself.
let onUninstallRequested = null;
function setUninstallHandler(handler) {
  onUninstallRequested = handler;
}

// Only regular employees get screen monitoring — managers/CEO run the agent
// for attendance only. The backend enforces the same rule on upload.
function screenshotsAllowedForRole(role) {
  return role === "employee";
}

// Last check-in state the SERVER confirmed, persisted to disk. Used only
// when the server can't be reached (no internet after a power cut, backend
// down): if this employee was last known to be checked in, screenshots keep
// being taken into the offline queue (see capture-scheduler.js) instead of
// silently stopping until the connection comes back. Check-out itself needs
// the web portal (i.e. internet), so "was checked in, now offline" almost
// always still means "checked in". Trusted for at most OFFLINE_TRUST_MS.
const CAPTURE_STATE_FILE = path.join(app.getPath("userData"), "capture-state.json");
const OFFLINE_TRUST_MS = 16 * 60 * 60 * 1000;

function saveCaptureState(userId, shouldCapture) {
  try {
    fs.writeFileSync(CAPTURE_STATE_FILE, JSON.stringify({ userId, shouldCapture, at: Date.now() }));
  } catch {
    // best-effort
  }
}

function loadCaptureState() {
  try {
    return JSON.parse(fs.readFileSync(CAPTURE_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function applyOfflineFallback(current) {
  if (captureScheduler.isRunning() || !screenshotsAllowedForRole(current.user?.role)) return;
  const state = loadCaptureState();
  if (state?.userId === current.user?.id && state.shouldCapture && Date.now() - state.at < OFFLINE_TRUST_MS) {
    logger.write("[attendance] server unreachable — last known status is checked in, capturing offline");
    captureScheduler.start();
  }
}

async function checkStatus() {
  const current = session.get();
  if (!current) {
    logger.write("[attendance] poll skipped — no active session");
    captureScheduler.stop();
    return;
  }

  if (!screenshotsAllowedForRole(current.user?.role)) {
    captureScheduler.stop();
  }

  try {
    const result = await withAuth((s) => apiClient.fetchCurrentAttendance(s.accessToken));
    if (result === SESSION_UNAVAILABLE) {
      logger.write("[attendance] poll skipped — session unavailable (refresh failed)");
      if (session.get()) applyOfflineFallback(current); // still signed in, just can't reach the server
      return;
    }

    const record = result;
    const checkedIn = Boolean(record?.check_in_time) && !record?.check_out_time;
    const shouldCapture = checkedIn && screenshotsAllowedForRole(current.user?.role);
    logger.write(
      `[attendance] poll for employee ${current.user.id} — ` +
        `check_in_time=${record?.check_in_time ?? "null"}, ` +
        `check_out_time=${record?.check_out_time ?? "null"} — ` +
        `capture=${shouldCapture ? "ON" : "OFF"}`,
    );

    saveCaptureState(current.user.id, shouldCapture);

    if (shouldCapture && !captureScheduler.isRunning()) {
      logger.write("[attendance] checked in — starting screenshot capture");
      captureScheduler.start();
    } else if (!shouldCapture && captureScheduler.isRunning()) {
      logger.write("[attendance] not checked in — stopping screenshot capture");
      captureScheduler.stop();
    }
    // Online again: push anything captured while the connection was down.
    if (captureScheduler.pendingCount() > 0) captureScheduler.flushQueue();
  } catch (err) {
    logger.write(`[attendance] status check failed: ${err.message}`);
    applyOfflineFallback(current);
  }
}

// Piggybacks on the same poll cycle as checkStatus rather than running its
// own timer — checked every ~15s, well inside the "1-2 minutes" a manager
// clicking "Refresh Agent Connections"/"Push Update Now" would expect a
// response within. Only reaches agents that are still logged in (have a
// session to poll with); an agent whose refresh token has already fully
// expired has no valid credential left and can't be reached by any signal,
// push or poll — only a human re-entering their password recovers that one.
async function checkResync() {
  const current = session.get();
  if (!current) return;

  try {
    const capture = captureScheduler.getCaptureStatus();
    const info = {
      version: app.getVersion(),
      platform: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : process.platform,
      captureStatus: capture.status,
      captureError: capture.error,
    };
    const status = await withAuth((s) => apiClient.fetchResyncStatus(s.accessToken, info));
    if (status === SESSION_UNAVAILABLE || !status) return;

    if (status.resync && status.resync.requestId !== lastActedResyncId) {
      logger.write(`[resync] new request #${status.resync.requestId} received — refreshing session and re-checking status`);
      lastActedResyncId = status.resync.requestId;

      const refreshed = await forceRefresh();
      if (refreshed === SESSION_UNAVAILABLE) {
        logger.write("[resync] proactive refresh failed — session is no longer valid");
      } else {
        await checkStatus(); // re-evaluate immediately with the refreshed session
        await withAuth((s) => apiClient.ackResync(s.accessToken, status.resync.requestId));
        logger.write(`[resync] acknowledged request #${status.resync.requestId}`);
      }
    }

    if (status.checkUpdate && status.checkUpdate.requestId !== lastActedUpdateCheckId) {
      logger.write(`[resync] new update-push #${status.checkUpdate.requestId} received — checking for update now`);
      lastActedUpdateCheckId = status.checkUpdate.requestId;

      const outcome = await updater.checkForUpdates();
      await withAuth((s) => apiClient.ackResync(s.accessToken, status.checkUpdate.requestId, outcome));
      logger.write(`[resync] acknowledged update-push #${status.checkUpdate.requestId} (outcome=${outcome ?? "unknown"})`);
    }
  } catch (err) {
    logger.write(`[resync] check failed: ${err.message}`);
  }
}

// Checked every poll cycle so an employee deleted while this agent is
// already running (not just at its next cold start — see main.js's
// startup check for that case) still gets the signal within ~15s, same
// delivery latency as resync/update-push. Uses the session's refresh token
// directly (not withAuth's access-token retry wrapper) — the
// agent-uninstall check endpoint verifies the refresh token's signature
// itself and doesn't need or want a normal authenticated session.
async function checkUninstall() {
  const current = session.get();
  if (!current) return;

  try {
    const status = await apiClient.checkUninstallStatus(current.refreshCookie);
    if (status?.shouldUninstall) {
      logger.write("[uninstall] pending uninstall request found while running — handing off");
      onUninstallRequested?.();
    }
  } catch (err) {
    logger.write(`[uninstall] check failed: ${err.message}`);
  }
}

function start() {
  // Only the poll timer is reset here — a running capture keeps going, so a
  // wake/resync restart doesn't fire an extra immediate screenshot.
  stopPollTimer();
  logger.write(`[attendance] poller starting, interval=${ATTENDANCE_POLL_INTERVAL_MS}ms`);
  checkStatus(); // check immediately so an already-checked-in session resumes right away
  timer = setInterval(() => {
    checkStatus();
    checkResync();
    checkUninstall();
  }, ATTENDANCE_POLL_INTERVAL_MS);
}

function stopPollTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.write("[attendance] poller stopped");
  }
}

// Full stop (logout, user switch, uninstall): polling AND screenshots.
function stop() {
  stopPollTimer();
  captureScheduler.stop();
}

module.exports = { start, stop, setUninstallHandler };
