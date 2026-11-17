const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const OUT_FILE = path.join(__dirname, "recorded-test.webm");

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(__dirname, "index.html");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

app.whenReady().then(async () => {
  const server = await startStaticServer();
  const port = server.address().port;
  console.log("[audio-test] serving test page on port", port);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  ipcMain.on("recording-result", (_event, result) => {
    if (result.status === "recording-started") {
      console.log("[audio-test] recording started (fake audio device)...");
      return;
    }
    if (result.status === "error") {
      console.error("[audio-test] ERROR:", result.message);
      console.error(result.stack);
      server.close();
      app.quit();
      return;
    }

    console.log("[audio-test] recording finished");
    console.log("[audio-test] blob.size:", result.size);
    console.log("[audio-test] blob.type:", result.type);
    console.log("[audio-test] chunk count:", result.chunkCount);

    const buffer = Buffer.from(result.base64, "base64");
    fs.writeFileSync(OUT_FILE, buffer);
    console.log("[audio-test] saved to:", OUT_FILE);
    console.log("[audio-test] saved file size on disk:", fs.statSync(OUT_FILE).size);

    server.close();
    win.close();
    app.quit();
  });

  win.loadURL(`http://127.0.0.1:${port}/index.html`);
});
