const { API_BASE_URL } = require("./config");

function extractRefreshCookie(res) {
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  const refreshCookie = cookies.find((c) => c.startsWith("refreshToken="));
  return refreshCookie ? refreshCookie.split(";")[0] : null;
}

async function login(email, password) {
  const res = await fetch(`${API_BASE_URL}/auth/agent-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected response from server");
  }

  if (!res.ok || !body.success) {
    throw new Error(body.message || "Login failed");
  }

  return { ...body.data, refreshCookie: extractRefreshCookie(res) }; // { accessToken, user, refreshCookie }
}

// Web CRM -> agent auto sign-in: trades the short-lived code the web app
// passed in the advertiser360agent://wake?code=... URL for a normal agent
// session, so the employee never has to type their password into the agent
// after already logging into the web CRM. Same return shape as login().
async function linkLogin(code) {
  const res = await fetch(`${API_BASE_URL}/auth/agent-link-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected response from server");
  }

  if (!res.ok || !body.success) {
    const error = new Error(body.message || "Link login failed");
    error.status = res.status;
    throw error;
  }

  return { ...body.data, refreshCookie: extractRefreshCookie(res) }; // { accessToken, user, refreshCookie }
}

async function refreshAccessToken(refreshCookie) {
  const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: refreshCookie ? { Cookie: refreshCookie } : undefined,
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected response from server");
  }

  if (!res.ok || !body.success) {
    // Tagged with .status so callers (session-refresh.js) can tell "the
    // server explicitly rejected this refresh token" (401 — genuinely
    // expired/invalid, safe to log out) apart from anything else (5xx, rate
    // limiting, etc. — the token itself may still be fine).
    const error = new Error(body.message || "Session refresh failed");
    error.status = res.status;
    throw error;
  }

  return {
    accessToken: body.data.accessToken,
    refreshCookie: extractRefreshCookie(res) || refreshCookie,
  };
}

// The record for whichever shift is currently open right now, resolved
// entirely server-side by PKT shift-date (see backend attendance.service.js
// getCurrentStatus / utils/shift.js resolveShiftDate) — or null if there
// isn't one. This used to be a 2-day from/to window built from the AGENT
// MACHINE'S OWN LOCAL CLOCK/TIMEZONE, which silently broke on any machine
// not set to Pakistan time (or right around a PKT day boundary even on a
// correctly-set one): the date window it asked for could miss the shift-date
// row the backend actually stored the check-in under, so status reads would
// silently be wrong with no error anywhere. Asking the server "what's my
// current status" instead removes the agent's local clock from the equation
// entirely.
async function fetchCurrentAttendance(accessToken) {
  const res = await fetch(`${API_BASE_URL}/attendance/me/current`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected response from server");
  }

  if (!res.ok || !body.success) {
    const error = new Error(body.message || `Attendance check failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return body.data ?? null;
}

// Checked on every attendance-poll cycle — returns the id/time of the most
// recent "refresh all agents" request a manager/CEO has made (or null if
// none has ever been made). The caller compares this id against the last
// one it already acted on to decide whether to do anything.
async function fetchResyncStatus(accessToken) {
  const res = await fetch(`${API_BASE_URL}/agent/resync-status`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected response from server");
  }

  if (!res.ok || !body.success) {
    const error = new Error(body.message || `Resync status check failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return body.data; // { requestId, requestedAt } or null
}

async function ackResync(accessToken, requestId, updateOutcome) {
  const res = await fetch(`${API_BASE_URL}/agent/resync-ack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requestId, updateOutcome: updateOutcome ?? undefined }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected response from server");
  }

  if (!res.ok || !body.success) {
    const error = new Error(body.message || `Resync ack failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }
}

// Checked on every attendance-poll cycle AND once at app startup (before
// any login/resume attempt — see main.js) so a machine that was fully
// offline when it got deleted still finds out the moment it reconnects,
// even weeks later. Deliberately hits its own top-level route
// (/api/agent-uninstall, not /api/agent) with the refresh cookie instead of
// an access token: see backend's agent-uninstall.routes.js for why this
// can't go through the normal authenticated endpoints (the employee row
// this agent belongs to may already be hard-deleted).
async function checkUninstallStatus(refreshCookie) {
  const res = await fetch(`${API_BASE_URL}/agent-uninstall/check`, {
    method: "POST",
    headers: refreshCookie ? { Cookie: refreshCookie } : undefined,
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Unexpected response from server");
  }

  if (!res.ok || !body.success) {
    const error = new Error(body.message || `Uninstall check failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return body.data; // { shouldUninstall }
}

// Best-effort — called right before this agent removes itself, so the
// dashboard's "still offline, not yet uninstalled" list clears promptly.
// Nothing downstream depends on this succeeding: the agent uninstalls
// itself either way, and a missed ack here just means that one row lingers
// on the dashboard list a little longer than it needed to.
async function ackUninstall(refreshCookie) {
  const res = await fetch(`${API_BASE_URL}/agent-uninstall/ack`, {
    method: "POST",
    headers: refreshCookie ? { Cookie: refreshCookie } : undefined,
  });
  try {
    await res.json();
  } catch {
    // Best-effort — ignore.
  }
}

module.exports = {
  login,
  linkLogin,
  refreshAccessToken,
  fetchCurrentAttendance,
  fetchResyncStatus,
  ackResync,
  checkUninstallStatus,
  ackUninstall,
};
