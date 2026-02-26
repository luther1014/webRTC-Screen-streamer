const path = require("path");
const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const { createServer } = require("../server/appServer");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "host.html"));
}

let serverInfo;

// app.whenReady().then(() => {
//   createWindow();
//   app.on("activate", () => {
//     if (BrowserWindow.getAllWindows().length === 0) createWindow();
//   });
// });

app.whenReady().then(async () => {
  // IMPORTANT: when packaged, your files are inside app.asar.
  // We will copy public assets out (next step) OR point to resources.
  const publicDir = path.join(__dirname, "..", "public");

  serverInfo = await createServer({ port: 8080, publicDir });
  console.log("Viewer URLs:");
  for (const ip of serverInfo.ips) {
    console.log(`  http://${ip}:${serverInfo.port}/view?room=demo`);
  }

  createWindow();
});

app.on("before-quit", () => {
  try {
    serverInfo?.server?.close();
  } catch {}
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// IPC: list capture sources
ipcMain.handle("screen:getSources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });

  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    // data URL thumbnail for UI
    thumbnail: s.thumbnail?.toDataURL?.() || null,
  }));
});
