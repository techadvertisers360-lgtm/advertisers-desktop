const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { captureScreenshotBuffer } = require("./capture");
const { uploadScreenshot } = require("./uploader");
const { withAuth, SESSION_UNAVAILABLE } = require("./session-refresh");
const { CAPTURE_INTERVAL_MS } = require("./config");
const session = require("./session");
const macPermissions = require("./mac-permissions");
const logger = require("./logger");

// Every capture is written to this on-disk queue FIRST and only deleted once
// the backend has accepted it. So when the internet (or power, or the
// backend) is down, screenshots keep being taken and simply pile up here;
// the moment the connection is back they're uploaded oldest-first with their
// ORIGINAL capture time. Files are named <employeeId>_<capturedAtMs>.jpg so
// a queue left behind by one employee is never uploaded under another
// employee's account on a shared machine.
const QUEUE_DIR = path.join(app.getPath("userData"), "pending-screenshots");
const MAX_QUEUED = 600; // ~50 hours at one capture / 5 min
const MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000; // backend accepts up to 7 days back
const FLUSH_BATCH = 30;

let timer = null;
let flushing = false;

function ensureQueueDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function parseQueueName(name) {
  const m = /^(\d+)_(\d+)\.jpg$/.exec(name);
  return m ? { employeeId: Number(m[1]), capturedAtMs: Number(m[2]) } : null;
}

function listQueue() {
  try {
    return fs
      .readdirSync(QUEUE_DIR)
      .map((name) => ({ name, ...parseQueueName(name) }))
      .filter((f) => f.capturedAtMs)
      .sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  } catch {
    return [];
  }
}

function removeQuietly(name) {
  try {
    fs.unlinkSync(path.join(QUEUE_DIR, name));
  } catch {
    // already gone
  }
}

function enqueue(employeeId, buffer, capturedAt) {
  ensureQueueDir();
  fs.writeFileSync(path.join(QUEUE_DIR, `${employeeId}_${capturedAt.getTime()}.jpg`), buffer);

  // Never let a very long outage fill the disk: drop expired and oldest.
  const queued = listQueue();
  const now = Date.now();
  let overflow = queued.length - MAX_QUEUED;
  for (const f of queued) {
    if (now - f.capturedAtMs > MAX_AGE_MS || overflow > 0) {
      removeQuietly(f.name);
      overflow -= 1;
    }
  }
}

function pendingCount() {
  return listQueue().length;
}

// Uploads queued screenshots for the signed-in employee, oldest first.
// Stops at the first network/server failure (still offline — try again
// later) and keeps those files. Safe to call often; concurrent calls no-op.
async function flushQueue() {
  const current = session.get();
  if (!current || flushing) return;
  flushing = true;
  try {
    const mine = listQueue().filter((f) => f.employeeId === current.user?.id);
    let uploaded = 0;
    for (const f of mine.slice(0, FLUSH_BATCH)) {
      if (Date.now() - f.capturedAtMs > MAX_AGE_MS) {
        removeQuietly(f.name);
        continue;
      }
      let buffer;
      try {
        buffer = fs.readFileSync(path.join(QUEUE_DIR, f.name));
      } catch {
        continue;
      }

      let result;
      try {
        result = await withAuth((s) => uploadScreenshot(s.accessToken, buffer, new Date(f.capturedAtMs)));
      } catch (err) {
        // A 4xx other than auth/rate-limit will never succeed on retry
        // (e.g. a corrupt file) — drop it instead of blocking the queue.
        if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          logger.write(`[capture] dropping queued screenshot ${f.name}: ${err.message}`);
          removeQuietly(f.name);
          continue;
        }
        logger.write(`[capture] upload deferred (${err.message}) — ${pendingCount()} screenshot(s) waiting`);
        break;
      }
      if (result === SESSION_UNAVAILABLE) {
        logger.write(`[capture] upload deferred (not connected) — ${pendingCount()} screenshot(s) waiting`);
        break;
      }
      removeQuietly(f.name);
      uploaded += 1;
      logger.write(`[capture] uploaded screenshot #${result.id} (captured ${result.captured_at})`);
    }
    if (uploaded > 0 && mine.length > uploaded) {
      logger.write(`[capture] ${pendingCount()} queued screenshot(s) still to upload`);
    }
  } finally {
    flushing = false;
  }
}

async function runCycle() {
  const current = session.get();
  if (!current) return;
  // macOS: without Screen Recording permission the capture is blank —
  // guide the user to switch it on instead (see mac-permissions.js).
  if (!(await macPermissions.ensureScreenPermission())) {
    await flushQueue();
    return;
  }
  try {
    const buffer = await captureScreenshotBuffer();
    enqueue(current.user.id, buffer, new Date());
  } catch (err) {
    logger.write(`[capture] capture failed: ${err.message}`);
  }
  await flushQueue();
}

function start() {
  if (timer) return; // already running
  logger.write(`[capture] scheduler starting, interval=${CAPTURE_INTERVAL_MS}ms`);
  runCycle(); // capture right away instead of waiting a full interval
  timer = setInterval(runCycle, CAPTURE_INTERVAL_MS);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.write("[capture] scheduler stopped");
  }
}

function isRunning() {
  return timer !== null;
}

module.exports = { start, stop, isRunning, flushQueue, pendingCount };
