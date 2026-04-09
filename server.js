const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/view", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

const PORT = 8080;

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

// Rooms: roomId -> { host: ws|null, viewers: Map<viewerId, ws> }
const rooms = new Map();
function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { host: null, viewers: new Map() });
  return rooms.get(roomId);
}
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcastViewers(roomId, obj) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [, vws] of room.viewers) send(vws, obj);
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function cleanup(ws) {
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
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    const msg = safeParse(String(raw));
    if (!msg?.type || !msg.roomId) return;

    const room = getRoom(msg.roomId);

    if (msg.type === "join") {
      if (msg.role === "host") {
        if (room.host && room.host !== ws)
          send(room.host, { type: "replaced" });
        room.host = ws;
        send(ws, { type: "joined", role: "host" });

        // tell host existing viewers
        for (const [viewerId] of room.viewers)
          send(ws, { type: "viewer-joined", viewerId });

        // tell viewers host is ready
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

    // relay offer/answer/ice
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

    if (msg.type === "viewer-message") {
      const viewerId = msg.viewerId;
      if (viewerId && room.host && room.host.readyState === WebSocket.OPEN) {
        send(room.host, msg);
      }
      return;
    }

    // broadcast timer messages from host to all viewers
    if (msg.type === "timer-start" || msg.type === "timer-stop" || msg.type === "timer-reset") {
      if (room.host === ws) {
        broadcastViewers(msg.roomId, msg);
      }
    }
  });

  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));
});

server.listen(PORT, () => {
  const ips = getLanIps();
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`LAN viewer URLs:`);
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/view?room=demo`);
});
