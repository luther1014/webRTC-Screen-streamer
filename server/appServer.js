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

  app.get("/view", (req, res) => {
    res.sendFile(path.join(publicDir, "viewer.html"));
  });

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  const rooms = new Map();

  function normalizeRoomKey(value) {
    return String(value || "").trim();
  }

  function getRoom(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        host: null,
        key: null,
        viewers: new Map(),
      });
    }
    return rooms.get(roomId);
  }

  function send(ws, obj) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function closeSocket(ws, code, reason) {
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      ws.close(code, reason);
    }
  }

  function broadcastViewers(roomId, obj) {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const [, viewer] of room.viewers) {
      send(viewer.ws, obj);
    }
  }

  function safeParse(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function denyJoin(ws, reason) {
    send(ws, { type: "join-denied", reason });
  }

  function cleanup(ws) {
    for (const [roomId, room] of rooms.entries()) {
      if (room.host === ws) {
        room.host = null;
        broadcastViewers(roomId, { type: "host-left" });
      }

      for (const [viewerId, viewer] of room.viewers.entries()) {
        if (viewer.ws === ws) {
          room.viewers.delete(viewerId);
          if (room.host) send(room.host, { type: "viewer-left", viewerId });
        }
      }

      if (!room.host && room.viewers.size === 0) {
        rooms.delete(roomId);
      }
    }
  }

  function handleHostJoin(ws, roomId, room, msg) {
    const roomKey = normalizeRoomKey(msg.roomKey);
    if (!roomKey) {
      denyJoin(ws, "room-key-required");
      return;
    }

    if (room.key && room.key !== roomKey) {
      denyJoin(ws, "invalid-room-key");
      return;
    }

    const previousHost = room.host;
    room.host = ws;
    room.key = roomKey;
    send(ws, { type: "joined", role: "host" });

    if (previousHost && previousHost !== ws) {
      send(previousHost, { type: "replaced" });
      closeSocket(previousHost, 4000, "Host replaced");
    }

    for (const [viewerId, viewer] of room.viewers.entries()) {
      if (viewer.roomKey !== room.key) {
        room.viewers.delete(viewerId);
        send(viewer.ws, { type: "join-denied", reason: "invalid-room-key" });
        closeSocket(viewer.ws, 4003, "Invalid room key");
        continue;
      }

      send(ws, { type: "viewer-joined", viewerId });
    }

    broadcastViewers(roomId, { type: "host-ready" });
  }

  function handleViewerJoin(ws, room, msg) {
    const viewerId = String(msg.viewerId || "").trim();
    const roomKey = normalizeRoomKey(msg.roomKey);
    if (!viewerId) {
      denyJoin(ws, "viewer-id-required");
      return;
    }

    if (room.key && room.key !== roomKey) {
      denyJoin(ws, "invalid-room-key");
      return;
    }

    const existingViewer = room.viewers.get(viewerId);
    if (existingViewer && existingViewer.ws !== ws) {
      send(existingViewer.ws, { type: "replaced" });
      closeSocket(existingViewer.ws, 4001, "Viewer replaced");
    }

    room.viewers.set(viewerId, { ws, roomKey });
    send(ws, {
      type: "joined",
      role: "viewer",
      viewerId,
      waitingForHost: !room.host,
    });

    if (room.host) {
      send(ws, { type: "host-ready" });
      send(room.host, { type: "viewer-joined", viewerId });
    }
  }

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = safeParse(String(raw));
      if (!msg?.type || !msg.roomId) return;

      const room = getRoom(msg.roomId);

      if (msg.type === "join") {
        if (msg.role === "host") {
          handleHostJoin(ws, msg.roomId, room, msg);
        }

        if (msg.role === "viewer") {
          handleViewerJoin(ws, room, msg);
        }

        return;
      }

      if (["offer", "answer", "ice"].includes(msg.type)) {
        const viewerId = String(msg.viewerId || "").trim();
        if (!viewerId) return;

        if (room.host === ws) {
          const viewer = room.viewers.get(viewerId);
          if (viewer) send(viewer.ws, msg);
        } else if (room.host) {
          send(room.host, msg);
        }
        return;
      }

      if (msg.type === "viewer-message") {
        const viewerId = String(msg.viewerId || "").trim();
        const viewer = room.viewers.get(viewerId);
        if (viewer?.ws === ws && room.host) {
          send(room.host, msg);
        }
        return;
      }

      if (
        msg.type === "timer-start" ||
        msg.type === "timer-stop" ||
        msg.type === "timer-reset"
      ) {
        if (room.host === ws) {
          const viewerId = String(msg.viewerId || "").trim();
          if (viewerId) {
            const viewer = room.viewers.get(viewerId);
            if (viewer) send(viewer.ws, msg);
          } else {
            broadcastViewers(msg.roomId, msg);
          }
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
