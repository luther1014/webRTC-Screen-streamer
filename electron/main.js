const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  Notification,
} = require("electron");

let win;
let serverProcess = null;

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }

  return ips;
}

function startInternalServer() {
  const serverPath = path.join(__dirname, "..", "server.js");

  serverProcess = fork(serverPath, [], {
    stdio: "inherit",
  });

  serverProcess.on("error", (err) => {
    console.error("Failed to start internal server:", err);
  });

  serverProcess.on("exit", (code) => {
    console.log("Internal server exited with code:", code);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "host.html"));
}

app.whenReady().then(() => {
  startInternalServer();
  createWindow();
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("screen:getSources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });

  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail?.toDataURL?.() || null,
  }));
});

ipcMain.handle("network:getLanIps", async () => {
  return getLanIps();
});

ipcMain.on("host:systemNotification", (_event, payload = {}) => {
  if (!Notification.isSupported() || !win || win.isDestroyed()) return;
  if (win.isFocused()) return;

  const title = String(payload.title || "Screen Stream Host");
  const body = String(payload.body || "");

  const notification = new Notification({
    title,
    body,
    silent: false,
  });

  notification.on("click", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  notification.show();
});
