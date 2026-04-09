const { contextBridge, ipcRenderer } = require("electron");
const QRCode = require("qrcode");

contextBridge.exposeInMainWorld("electronAPI", {
  getSources: () => ipcRenderer.invoke("screen:getSources"),
  getLanIps: () => ipcRenderer.invoke("network:getLanIps"),
  makeQRCodeDataUrl: async (text) => {
    return await QRCode.toDataURL(text, {
      width: 240,
      margin: 2,
    });
  },
});
