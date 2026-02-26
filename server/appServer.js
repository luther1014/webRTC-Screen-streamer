const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function createServer({ port = 8080, publicDir }) {
  const app = express();
  app.use(express.static(publicDir));

  // nice alias
  app.get("/view", (req, res) => {
    res.sendFile(path.join(publicDir, "viewer.html"));
  });

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // --- signaling state ---
  const rooms = new Map();
  const getRoom = (id) => {
    if (!rooms.has(id)) rooms.set(id, { host: null, viewers: new Map() });
    return rooms.get(id);
  };
  const send = (ws, obj) =>
    ws?.readyState === 1 && ws.send(JSON.stringify(obj));
  const broadcastViewers = (roomId, obj) => {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const [, vws] of room.viewers) send(vws, obj);
  };
  const safeParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const cleanup = (ws) => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.host === ws) {
        room.host = null;
        broadcastViewers(roomId, { type: "host-left" });
      }
      for (const [viewerId, vws] of room.viewers.entries()) {
        if (vws === ws) {
          room.viewers.delete(viewerId);
          if (room.host) send(room.host, { type: "viewer-left", viewerId });
        }
      }
      if (!room.host && room.viewers.size === 0) rooms.delete(roomId);
    }
  };

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = safeParse(String(raw));
      if (!msg?.type || !msg.roomId) return;

      const room = getRoom(msg.roomId);

      if (msg.type === "join") {
        if (msg.role === "host") {
          room.host = ws;
          send(ws, { type: "joined", role: "host" });
          for (const [viewerId] of room.viewers)
            send(ws, { type: "viewer-joined", viewerId });
          broadcastViewers(msg.roomId, { type: "host-ready" });
        }
        if (msg.role === "viewer") {
          const viewerId = msg.viewerId;
          if (!viewerId) return;
          room.viewers.set(viewerId, ws);
          send(ws, { type: "joined", role: "viewer", viewerId });
          if (room.host) {
            send(ws, { type: "host-ready" });
            send(room.host, { type: "viewer-joined", viewerId });
          }
        }
        return;
      }

      if (["offer", "answer", "ice"].includes(msg.type)) {
        const viewerId = msg.viewerId;
        if (!viewerId) return;

        if (room.host === ws) {
          const vws = room.viewers.get(viewerId);
          if (vws) send(vws, msg);
        } else {
          if (room.host) send(room.host, msg);
        }
      }
    });

    ws.on("close", () => cleanup(ws));
    ws.on("error", () => cleanup(ws));
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", () => {
      resolve({ server, port, ips: getLanIps() });
    });
    server.on("error", reject);
  });
}

module.exports = { createServer };
