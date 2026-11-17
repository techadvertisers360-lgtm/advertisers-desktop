const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { app } = require("electron");
const logger = require("./logger");

// electron-builder's NSIS target (see package.json's "nsis" config —
// perMachine: false, so this is a per-user install with no admin rights
// needed for either install or uninstall) always writes an
// "Uninstall <productName>.exe" into the install directory alongside the
// main executable. process.execPath *is* that install directory's main
// exe once packaged, so its own directory is exactly where to look.
function findWindowsUninstaller() {
  const installDir = path.dirname(process.execPath);
  const candidate = path.join(installDir, `Uninstall ${app.getName()}.exe`);
  return fs.existsSync(candidate) ? candidate : null;
}

// NSIS's generated uninstaller silently copies itself to a temp dir before
// running (specifically so it can delete its own .exe and, if now empty,
// the install directory too) — that only happens when NOT passed an
// `_?=<dir>` override, so this deliberately omits one: the point here is
// full removal, not leaving the shell behind. `/S` is NSIS's own silent
// flag (no UI, no prompts).
function runWindowsUninstall() {
  const uninstaller = findWindowsUninstaller();
  if (!uninstaller) {
    logger.write("[uninstall] could not locate the NSIS uninstaller next to the running exe — aborting");
    return false;
  }
  logger.write(`[uninstall] launching silent uninstaller: "${uninstaller}" /S`);
  try {
    const child = spawn(uninstaller, ["/S"], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (err) {
    logger.write(`[uninstall] failed to launch uninstaller: ${err.message}`);
    return false;
  }
}

// The dmg target has no generated uninstaller — on macOS "uninstalled"
// means the .app bundle is gone from where it was dragged/installed to.
// process.execPath inside a running packaged app is
// <bundle>.app/Contents/MacOS/<exe name>, so three levels up is the bundle
// root. A detached shell script (not something done in-process) both
// avoids trying to delete files still open under this very process and
// lets the removal keep going after this process has quit.
function runMacUninstall() {
  const bundlePath = path.resolve(process.execPath, "..", "..", "..");
  if (!bundlePath.endsWith(".app")) {
    logger.write(`[uninstall] resolved bundle path doesn't look like a .app, aborting: ${bundlePath}`);
    return false;
  }

  const supportDir = path.join(app.getPath("appData"), app.getName());
  const pid = process.pid;
  // Waits for this exact process to actually exit before touching
  // anything — macOS doesn't lock a running executable's file the way
  // Windows does, but there's no reason to race a live process either.
  const script = [
    `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
    `rm -rf "${bundlePath}"`,
    `rm -rf "${supportDir}"`,
  ].join("\n");

  logger.write(`[uninstall] launching detached removal script for "${bundlePath}"`);
  try {
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (err) {
    logger.write(`[uninstall] failed to launch removal script: ${err.message}`);
    return false;
  }
}

// Returns true if a removal was actually kicked off (the caller should then
// exit promptly so Windows can delete the running exe / the mac script's
// wait loop can finish quickly), false if it couldn't even start one — the
// caller's fallback in that case is just a normal quit, leaving the install
// in place for a manager to deal with manually.
//
// Only ever called against a packaged, installed copy (main.js guards this
// behind app.isPackaged before calling in) — there is no NSIS uninstaller
// or real .app bundle to find during `electron .` dev runs, and this must
// never be attempted against a dev checkout.
function performSilentUninstall() {
  if (process.platform === "win32") return runWindowsUninstall();
  if (process.platform === "darwin") return runMacUninstall();
  logger.write(`[uninstall] unsupported platform for self-uninstall: ${process.platform}`);
  return false;
}

module.exports = { performSilentUninstall };
