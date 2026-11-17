const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const logger = require("./logger");

// Lets the agent resume a session across a full app/laptop restart without
// the employee re-entering their password — directly fixes "attendance
// tracking permanently stops after a restart until someone manually logs
// back in".
//
// Only the refresh token + basic user info are ever written here — never
// the email/password. A refresh token is a short-lived (7 day, see
// JWT_REFRESH_EXPIRES_IN), server-revocable delegated credential, not the
// account's actual secret, so persisting it is the same trust model regular
// browsers/desktop apps (Slack, Discord, VS Code, etc.) already use for
// "stay signed in". It's also encrypted at rest via Electron's safeStorage,
// which is backed by the OS's own per-user credential store (DPAPI on
// Windows, Keychain on macOS) — only this OS user account can decrypt it,
// same guarantee a browser's saved-login store has.
function storePath() {
  return path.join(app.getPath("userData"), "session.enc");
}

function save({ refreshCookie, user }) {
  if (!safeStorage.isEncryptionAvailable()) {
    logger.write("[session-store] OS encryption unavailable — not persisting session across restarts");
    return;
  }
  try {
    const payload = JSON.stringify({ refreshCookie, user });
    const encrypted = safeStorage.encryptString(payload);
    fs.writeFileSync(storePath(), encrypted);
  } catch (err) {
    logger.write(`[session-store] failed to save: ${err.message}`);
  }
}

function load() {
  const file = storePath();
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;

  try {
    const encrypted = fs.readFileSync(file);
    const payload = safeStorage.decryptString(encrypted);
    return JSON.parse(payload); // { refreshCookie, user }
  } catch (err) {
    logger.write(`[session-store] failed to load (treating as no saved session): ${err.message}`);
    return null;
  }
}

function clear() {
  try {
    fs.unlinkSync(storePath());
  } catch {
    // Nothing to clear — fine either way.
  }
}

module.exports = { save, load, clear };
