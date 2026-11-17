const { app, BrowserWindow, ipcMain, Notification, powerMonitor } = require("electron");
const path = require("node:path");
const apiClient = require("./api-client");
const session = require("./session");
const secureStore = require("./secure-session-store");
const { createTray, destroyTray } = require("./tray");
const attendancePoller = require("./attendance-poller");
const { setSessionExpiredHandler } = require("./session-refresh");
const updater = require("./updater");
const selfUninstall = require("./self-uninstall");
const logger = require("./logger");

// Lets the web CRM "wake" this app in the background on every browser login
// (see wakeDesktopAgent() in the frontend) instead of the employee ever
// having to find and open a second app themselves — the browser navigates
// to `advertiser360agent://wake`, and the OS either launches this app (if it
// was fully closed) or hands the URL to the already-running instance via
// the single-instance lock below.
const WAKE_PROTOCOL = "advertiser360agent";

// Without this, every browser-triggered wake while the app is ALREADY
// running would have the OS spawn a brand new Electron process alongside
// the existing one — a second tray icon, a second attendance poller, both
// running concurrently and fighting each other. requestSingleInstanceLock()
// makes any such second launch hand its argv off to the first instance (via
// 'second-instance' below) and exit immediately instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return; // top-level return is valid — Node wraps each module in a function
}

// electron-builder's NSIS/Mac config also registers this protocol at install
// time (see package.json's "protocols" field) — this call is what makes it
// work even for the current install without needing a reinstall, and is a
// harmless no-op re-registration on every subsequent launch either way.
// The `process.defaultApp` branch only matters when running unpackaged via
// `electron .` during local development.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(WAKE_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(WAKE_PROTOCOL);
}

function extractWakeUrl(argv) {
  return argv.find((arg) => arg.startsWith(`${WAKE_PROTOCOL}://`)) ?? null;
}

// advertiser360agent://wake?code=<agent link code> — the code is minted by
// the backend for the employee who just logged into the web CRM (see
// createAgentLinkCode in backend auth.service.js). Older web builds send a
// bare advertiser360agent://wake with no code, which still works exactly as
// before (silent resume only).
function extractLinkCode(wakeUrl) {
  if (!wakeUrl) return null;
  try {
    return new URL(wakeUrl).searchParams.get("code") || null;
  } catch {
    return null;
  }
}

// Signs the agent in as whoever just logged into the web CRM, using the
// link code from the wake URL — this is what saves the employee from typing
// their password into the agent a second time. If the agent is already
// signed in as that same employee, it just refreshes the tokens and
// re-polls; if it's signed in as someone else (shared machine), it switches
// over to the person who actually just logged in on the web. Returns true
// on success, false if the code was rejected/expired or the backend was
// unreachable (caller decides what to fall back to).
async function signInWithLinkCode(code, { silent = true } = {}) {
  let result;
  try {
    result = await apiClient.linkLogin(code);
  } catch (err) {
    logger.write(`[wake] link-code sign-in failed: ${err.message}`);
    return false;
  }

  const { accessToken, refreshCookie, user } = result;
  const current = session.get();
  session.set({ accessToken, refreshCookie, user });
  secureStore.save({ refreshCookie, user });
  logger.write(`[wake] signed in via web CRM link as ${user?.email ?? "unknown user"}`);

  if (current && current.user?.id === user?.id) {
    attendancePoller.start();
    return true;
  }
  if (current) {
    attendancePoller.stop();
    destroyTray();
  }

  const applyingUpdate = await maybeApplyUpdateBeforeContinuing(silent);
  if (applyingUpdate) return true;

  startSignedInSession(user);
  return true;
}

// The actual "wake up" behavior. Strictly invisible by design — the
// employee is looking at their web CRM, not this app, and must never see
// any sign that it exists or that anything just happened. Two cases:
//  - Already signed in (app was just minimized/backgrounded, not closed) —
//    nothing is actually broken, but restarting the poller forces an
//    immediate status re-check instead of waiting up to ~15s for the next
//    natural cycle, same safety net as the dashboard's resync signal. This
//    never touches any window.
//  - Not signed in in-memory (app was fully closed, or never logged in on
//    this machine) — tryResumeSession() silently restores the last saved
//    session if one exists. If it can't (no saved session, or the saved
//    refresh token is genuinely dead), this deliberately does NOT fall back
//    to a login window the way a manual launch would — a password prompt
//    appearing out of nowhere while the employee is on the web CRM would be
//    exactly the kind of surprise this feature exists to avoid. The
//    employee will simply keep seeing "offline" on the dashboard until a
//    manager/CEO reaches them some other way (Fix All Agents Now's offline
//    list, a message), same as before this feature existed — wake only ever
//    helps silently, it never surfaces a new prompt.
async function handleWakeSignal(wakeUrl) {
  logger.write("[wake] wake signal received (web CRM login)");
  const code = extractLinkCode(wakeUrl);
  // With a link code the agent can sign itself in as the web CRM user —
  // including closing a login window the employee left open, since that's
  // exactly the password prompt this feature exists to save them from.
  if (code && (await signInWithLinkCode(code, { silent: true }))) {
    return;
  }
  if (session.get()) {
    attendancePoller.start();
    return;
  }
  if (loginWindow) {
    // The employee already has a real login window open themselves (from a
    // direct, manual launch) — leave it exactly as is, don't touch it.
    return;
  }
  await tryResumeSession({ silent: true });
}

// Windows/Linux: an already-running instance gets the new launch's argv
// (including the advertiser360agent:// URL) handed to it here instead of a
// second process actually starting — see requestSingleInstanceLock above.
// A wake-triggered relaunch attempt deliberately does NOT focus/restore any
// window — doing so would pull a window in front of whatever the employee
// is actually looking at (their browser), which is exactly what this
// feature must never do. A genuine manual re-launch (desktop icon
// double-clicked again, no wake URL involved) still focuses the existing
// login window as before — that one really was the employee trying to open
// this app themselves.
app.on("second-instance", (_event, argv) => {
  const wakeUrl = extractWakeUrl(argv);
  if (wakeUrl) {
    handleWakeSignal(wakeUrl);
    return;
  }
  if (loginWindow) {
    if (loginWindow.isMinimized()) loginWindow.restore();
    loginWindow.focus();
  }
});

// macOS's equivalent of second-instance for custom-protocol launches. Unlike
// Windows, a Mac cold launch via URL never puts it in process.argv — it only
// ever arrives through this event, which can fire before app.whenReady() has
// resolved. If it fires that early, don't act on it directly (there's
// nothing to act on yet, and whenReady() below is about to make its own
// resume attempt); just remember that this launch was wake-triggered so
// whenReady() knows to stay silent (no login window) if resume fails,
// instead of quietly duplicating the resume attempt here too.
let pendingWakeUrlBeforeReady = null;

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!url.startsWith(`${WAKE_PROTOCOL}://`)) return;
  if (!app.isReady()) {
    pendingWakeUrlBeforeReady = url;
    return;
  }
  handleWakeSignal(url);
});

let loginWindow = null;
let updatingWindow = null;

// Shown only when checkAndApplyBlocking() has actually found a newer version
// and is waiting for it to finish downloading — never for the ordinary "no
// update" case, so a normal login never sees anything different from today.
// The process exits on its own moments after this appears (quitAndInstall
// relaunches the app), so there's nothing to wire up beyond showing text.
function showUpdatingWindow() {
  if (updatingWindow) return;
  if (loginWindow) {
    loginWindow.close();
  }
  updatingWindow = new BrowserWindow({
    width: 360,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Advertisers360 Agent",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  updatingWindow.setMenuBarVisibility(false);
  updatingWindow.loadFile(path.join(__dirname, "renderer", "updating.html"));
  updatingWindow.on("closed", () => {
    updatingWindow = null;
  });
}

function hideUpdatingWindow() {
  if (updatingWindow) {
    updatingWindow.close();
  }
}

// Called right before an already-authenticated session (fresh login or a
// resumed one) would normally proceed to startSignedInSession(). Checks for
// a newer version and, if the download finishes within the timeout, installs
// it and restarts the app immediately — the employee never sees more than a
// few seconds of "Updating..." on top of their normal login, and never has
// to do anything else themselves. Returns true if the app is exiting to
// install the update (caller must not do anything further); false if login
// should just continue normally on the current version.
//
// `silent` is true for anything triggered by the web-CRM wake signal, where
// the employee never opened this app at all and must never see any window
// from it — the update still happens (autoDownload + quitAndInstall both
// run exactly the same either way), it just never shows the "Updating..."
// splash while doing it.
async function maybeApplyUpdateBeforeContinuing(silent = false) {
  const applying = await updater.checkAndApplyBlocking({
    onUpdating: silent ? undefined : showUpdatingWindow,
  });
  if (!applying) {
    hideUpdatingWindow();
  }
  return applying;
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 360,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Advertisers360 Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, "renderer", "login.html"));

  loginWindow.on("closed", () => {
    loginWindow = null;
  });
}

function startSignedInSession(user) {
  if (loginWindow) {
    loginWindow.close();
  }
  createTray({ user, onLogout: () => handleLogout() });
  attendancePoller.start();
}

// `auto: true` means this logout was triggered by the session silently
// expiring (a definitive 401 on refresh — see session-refresh.js), not the
// user choosing "Logout" from the tray menu. Either way the saved session
// is cleared: for `auto` it's already dead so there's nothing worth keeping,
// and for a manual logout leaving it behind would let the app silently sign
// the same person back in on next launch, which defeats the point of
// clicking Logout.
function handleLogout({ auto = false } = {}) {
  attendancePoller.stop();
  session.clear();
  secureStore.clear();
  destroyTray();
  createLoginWindow();

  if (auto && Notification.isSupported()) {
    new Notification({
      title: "Advertisers360 Agent — signed out",
      body: "Your session expired, so attendance monitoring has stopped. Please open the app and log in again to resume it.",
    }).show();
  }
}

setSessionExpiredHandler(() => handleLogout({ auto: true }));

// The whole point of this feature: no window, no prompt, no confirmation —
// a deleted employee's machine just quietly stops running this app. Called
// both from an already-running session (attendancePoller's poll cycle, via
// setUninstallHandler below) and from app.whenReady() before any
// login/resume attempt is even considered (see below), so a fully-offline
// machine that only reconnects days later still hits this first, before it
// ever tries to act as a normal signed-in session again.
let uninstalling = false;
async function performUninstallFlow() {
  if (uninstalling) return; // already in progress (poll cycle + startup check can't both fire, but be safe)
  uninstalling = true;
  logger.write("[uninstall] pending uninstall confirmed — tearing down and removing this install");

  attendancePoller.stop();

  // Logout/session-clear first, same as a manual logout — the account this
  // credential belonged to is already gone server-side, so there is no
  // session worth keeping regardless of whether the uninstall itself
  // succeeds below.
  const credentialForAck = session.get()?.refreshCookie ?? secureStore.load()?.refreshCookie ?? null;
  session.clear();
  secureStore.clear();
  destroyTray();
  if (loginWindow) {
    loginWindow.close();
  }

  // Best-effort: lets the dashboard's "still offline, not yet uninstalled"
  // list clear promptly. The agent removes itself either way if this fails
  // or the machine is offline right now — see agentUninstall.controller.js.
  try {
    if (credentialForAck) await apiClient.ackUninstall(credentialForAck);
  } catch (err) {
    logger.write(`[uninstall] ack failed (continuing anyway): ${err.message}`);
  }

  if (!app.isPackaged) {
    logger.write("[uninstall] running unpackaged (dev) — skipping the actual uninstall step, just quitting");
    app.quit();
    return;
  }

  const started = selfUninstall.performSilentUninstall();
  if (!started) {
    logger.write("[uninstall] could not start the silent uninstaller — quitting normally, install left in place");
  }
  // Exit rather than quit: releases this process's lock on its own .exe
  // immediately so the (already-launched, detached) uninstaller can delete
  // it, instead of waiting on normal window/before-quit teardown.
  app.exit(0);
}

attendancePoller.setUninstallHandler(() => {
  performUninstallFlow();
});

ipcMain.handle("auth:login", async (_event, { email, password }) => {
  const { accessToken, refreshCookie, user } = await apiClient.login(email, password);
  // Saved before the update check runs, not after — if an update is found
  // and applied, the app restarts within seconds, and it's this saved
  // session that lets the relaunched (now up to date) instance resume
  // straight into monitoring via tryResumeSession() without asking the
  // employee to type their password a second time.
  session.set({ accessToken, refreshCookie, user });
  secureStore.save({ refreshCookie, user });

  const applyingUpdate = await maybeApplyUpdateBeforeContinuing();
  if (applyingUpdate) return { user, updating: true };

  startSignedInSession(user);
  return { user };
});

// On every launch — including after a laptop reboot or the app being
// closed and reopened, both of which wipe the in-memory session — this
// tries to resume from the encrypted session saved at last login before
// ever showing the login window. If the saved refresh token still works,
// the employee sees nothing at all: no login prompt, monitoring just
// resumes on its own the moment attendancePoller's first check finds them
// still checked in. This is what actually fixes "restart kills monitoring
// until someone manually logs back in" — previously there was nothing to
// resume from at all, since the session lived only in memory.
//
// `silent` (true when this was triggered by the web-CRM wake signal, not a
// normal app launch) only affects the update-splash — see
// maybeApplyUpdateBeforeContinuing. What happens on failure is entirely the
// caller's decision (see handleWakeSignal vs app.whenReady below), since
// only the caller knows whether showing a login window is appropriate here.
async function tryResumeSession({ silent = false } = {}) {
  const saved = secureStore.load();
  if (!saved?.refreshCookie) return false;

  try {
    const { accessToken, refreshCookie } = await apiClient.refreshAccessToken(saved.refreshCookie);
    session.set({ accessToken, refreshCookie, user: saved.user });
    secureStore.save({ refreshCookie, user: saved.user });
    logger.write(`[main] resumed saved session for ${saved.user?.email ?? "unknown user"}`);

    const applyingUpdate = await maybeApplyUpdateBeforeContinuing(silent);
    if (applyingUpdate) return true;

    startSignedInSession(saved.user);
    return true;
  } catch (err) {
    // A definitive 401 means the saved refresh token is genuinely dead
    // (expired past its 7-day window, or revoked) — no point keeping it.
    // Anything else (offline at boot, DNS not up yet, backend briefly
    // unreachable) is transient: keep the saved session and run offline
    // (below), rather than deleting a perfectly-good credential just
    // because the network wasn't ready yet.
    if (err.status === 401) {
      logger.write("[main] saved session rejected (401) — clearing it");
      secureStore.clear();
      return false;
    }
    // Transient (no internet yet after a power cut / boot, DNS not up,
    // backend briefly down): the saved credential is still good, so start
    // the signed-in session in OFFLINE mode instead of showing a login
    // window or quitting. accessToken is null, so the first API call that
    // gets through returns 401 and withAuth refreshes it automatically —
    // i.e. the agent reconnects by itself the moment the network is back,
    // and meanwhile attendance-poller keeps capturing into the offline
    // queue if the employee was last known to be checked in.
    logger.write(
      `[main] could not reach server (${err.message}) — starting offline with saved session for ${saved.user?.email ?? "unknown user"}; will reconnect automatically`,
    );
    session.set({ accessToken: null, refreshCookie: saved.refreshCookie, user: saved.user });
    startSignedInSession(saved.user);
    return true;
  }
}

app.whenReady().then(async () => {
  // Runs the agent automatically when the employee turns their computer on
  // — combined with tryResumeSession() above, this is what makes "laptop
  // ON, agent already running, checked-in status resumes on its own" work
  // with zero clicks, per the requirement that employees never touch
  // anything beyond Check In/Check Out.
  app.setLoginItemSettings({ openAtLogin: true });

  // Laptop woke from sleep / lid opened: timers were frozen while asleep,
  // so re-check attendance (and flush any offline screenshots) right away
  // instead of waiting for the next tick.
  powerMonitor.on("resume", () => {
    if (session.get()) {
      logger.write("[main] system resumed from sleep — re-checking status");
      attendancePoller.start();
    }
  });

  // Checked first, before any login window or session-resume attempt: if
  // this employee was deleted while this machine was completely offline
  // (the "forgotten laptop" case), the very first thing this launch does
  // must be uninstalling — never a normal resume, and never a password
  // prompt. Reads straight from the encrypted on-disk session rather than
  // session.get() (nothing is loaded into memory yet at this point), and
  // uses the same refresh-token-signature check regardless of whether that
  // token has actually expired — see checkUninstallStatus/
  // verifyRefreshTokenIgnoringExpiry for why an expired-but-genuine token
  // still works here. A failed/offline check is not treated as "no" — it
  // just means startup continues normally and the poll-cycle check (or the
  // next launch) gets another chance.
  const savedForUninstallCheck = secureStore.load();
  if (savedForUninstallCheck?.refreshCookie) {
    try {
      const status = await apiClient.checkUninstallStatus(savedForUninstallCheck.refreshCookie);
      if (status?.shouldUninstall) {
        logger.write("[uninstall] pending uninstall found at startup — uninstalling before anything else");
        await performUninstallFlow();
        return;
      }
    } catch (err) {
      logger.write(`[uninstall] startup check failed (continuing normal startup): ${err.message}`);
    }
  }

  // On Windows/Linux, if this very process only exists because the OS
  // launched it in response to the wake protocol (the app was fully closed
  // when the employee logged into the web CRM), the URL arrives as one of
  // this process's own argv rather than through 'second-instance' — there's
  // no already-running instance to hand it to. Treat it exactly like any
  // other wake signal: silent resume attempt, and absolutely no window
  // (including no login window) if that fails. Quitting straight back out
  // on failure — rather than lingering with no window and no tray — means
  // each wake attempt is self-contained: it either ends with the agent
  // properly signed in and running, or it's completely gone again, never a
  // stuck invisible process sitting idle in the background.
  const wakeUrl = extractWakeUrl(process.argv) || pendingWakeUrlBeforeReady;
  const launchedViaWake = Boolean(wakeUrl);
  const linkCode = extractLinkCode(wakeUrl);
  const resumed =
    (linkCode && (await signInWithLinkCode(linkCode, { silent: true }))) ||
    (await tryResumeSession({ silent: launchedViaWake }));
  if (!resumed) {
    if (launchedViaWake) {
      logger.write("[wake] could not resume on wake-triggered launch — quitting silently");
      app.quit();
      return;
    }
    createLoginWindow();
  }
  updater.start();
});

app.on("window-all-closed", () => {
  // Keep the app alive when the login window closes after a successful
  // login — it should keep running from the tray. Only quit if there's
  // no active session.
  if (!session.get()) {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && !session.get()) {
    createLoginWindow();
  }
});
