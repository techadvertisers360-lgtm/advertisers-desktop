const apiClient = require("./api-client");
const session = require("./session");
const secureStore = require("./secure-session-store");

const SESSION_UNAVAILABLE = Symbol("SESSION_UNAVAILABLE");

let onSessionExpired = null;

function setSessionExpiredHandler(handler) {
  onSessionExpired = handler;
}

async function refreshSession(current) {
  try {
    const { accessToken, refreshCookie } = await apiClient.refreshAccessToken(
      current.refreshCookie,
    );
    const updated = { ...current, accessToken, refreshCookie };
    session.set(updated);
    // Persist the rotated refresh token too — otherwise the copy on disk
    // stays the one from the last app start, and a restart more than 7 days
    // after that (laptop never rebooted in between) would find it expired.
    secureStore.save({ refreshCookie, user: current.user });
    return updated;
  } catch (err) {
    // Only a definitive 401 from the server means the refresh token itself
    // is genuinely invalid/expired — that's the one case it's correct to
    // log out. Anything else (no internet, DNS hiccup, the backend being
    // briefly unreachable, a 5xx) is a transient failure to *check*, not
    // evidence the session is actually dead — logging out on those would
    // wipe a perfectly good session (and the persisted one on disk) over a
    // momentary network blip, forcing a manual re-login for no real reason.
    // Just report this attempt as unavailable and let the next poll retry.
    if (err.status === 401) {
      console.error("[session] refresh token rejected (401) — logging out:", err.message);
      onSessionExpired?.();
    } else {
      console.error("[session] refresh attempt failed (transient, not logging out):", err.message);
    }
    return null;
  }
}

// Runs fn(sessionData) with the current session, transparently retrying once
// with a refreshed access token on a 401. Returns SESSION_UNAVAILABLE if
// there's no session or the refresh itself failed (already logged out by
// then) — callers must check for that sentinel before using the result,
// since fn() may legitimately resolve to null/undefined on success.
async function withAuth(fn) {
  const current = session.get();
  if (!current) return SESSION_UNAVAILABLE;

  try {
    return await fn(current);
  } catch (err) {
    if (err.status === 401) {
      const refreshed = await refreshSession(current);
      if (refreshed) {
        return fn(refreshed);
      }
      return SESSION_UNAVAILABLE;
    }
    throw err;
  }
}

// Proactively renews the access token instead of waiting for a 401 to
// trigger it reactively — used when a "refresh all agents" signal comes in,
// so a session that's close to expiring (but not dead yet) gets renewed
// right away rather than possibly lapsing before its next natural refresh.
// Returns SESSION_UNAVAILABLE (and logs the session out) if there's no
// session or the refresh itself fails, same as withAuth's own failure path.
async function forceRefresh() {
  const current = session.get();
  if (!current) return SESSION_UNAVAILABLE;
  const refreshed = await refreshSession(current);
  return refreshed ?? SESSION_UNAVAILABLE;
}

module.exports = { withAuth, forceRefresh, setSessionExpiredHandler, SESSION_UNAVAILABLE };
