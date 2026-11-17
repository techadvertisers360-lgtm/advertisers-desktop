const { Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");

let tray = null;

function createTray({ user, onLogout }) {
  if (tray) return tray;

  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray-icon.png"));
  tray = new Tray(icon);
  tray.setToolTip(`Advertisers360 Agent — signed in as ${user.full_name}`);

  const menu = Menu.buildFromTemplate([
    { label: `Signed in as ${user.full_name}`, enabled: false },
    { type: "separator" },
    { label: "Logout", click: onLogout },
  ]);
  tray.setContextMenu(menu);

  return tray;
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, destroyTray };
