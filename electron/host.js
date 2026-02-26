// Electron host: captures via getUserMedia using chromeMediaSourceId
const $room = document.getElementById("room");
const $server = document.getElementById("server");
const $connect = document.getElementById("connect");
const $status = document.getElementById("status");
const $pick = document.getElementById("pick");
const $start = document.getElementById("start");
const $stop = document.getElementById("stop");
const $preview = document.getElementById("preview");
const $sources = document.getElementById("sources");
const $viewerLink = document.getElementById("viewerLink");
const $log = document.getElementById("log");

// const QRCode = require("qrcode"); // Electron renderer can require ONLY if nodeIntegration=true

function log(...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  console.log(...args);
  $log.textContent += line + "\n";
  $log.scrollTop = $log.scrollHeight;
}
function setStatus(s) {
  $status.textContent = s;
}

let ws = null;
let screenStream = null;
let selectedSourceId = null;

// One peer per viewer
const peers = new Map(); // viewerId -> RTCPeerConnection

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ...msg, roomId: $room.value.trim() }));
}

function updateViewerLink() {
  const room = encodeURIComponent($room.value.trim() || "demo");
  $viewerLink.textContent = `http://LAN-IP:8080/view?room=${room}`;
}
$room.addEventListener("input", updateViewerLink);
updateViewerLink();

function ensurePeer(viewerId) {
  if (peers.has(viewerId)) return peers.get(viewerId);

  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "ice", viewerId, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    log(`[pc ${viewerId}] state=${pc.connectionState}`);
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      try {
        pc.close();
      } catch {}
      peers.delete(viewerId);
    }
  };

  // attach current tracks if already captured
  if (screenStream) {
    for (const track of screenStream.getTracks())
      pc.addTrack(track, screenStream);
  }

  peers.set(viewerId, pc);
  return pc;
}

async function makeOffer(viewerId) {
  const pc = ensurePeer(viewerId);
  const offer = await pc.createOffer({
    offerToReceiveVideo: true,
    offerToReceiveAudio: false,
  });
  await pc.setLocalDescription(offer);
  send({ type: "offer", viewerId, sdp: pc.localDescription });
  log(`Sent offer -> ${viewerId}`);
}

async function loadSources() {
  const sources = await window.electronAPI.getSources();
  $sources.innerHTML = "";
  for (const s of sources) {
    const card = document.createElement("button");
    card.style.width = "260px";
    card.style.textAlign = "left";
    card.style.borderRadius = "12px";
    card.style.border = "1px solid #ddd";
    card.style.padding = "10px";
    card.style.background = selectedSourceId === s.id ? "#eef" : "#fff";

    const title = document.createElement("div");
    title.textContent = s.name;
    title.style.fontWeight = "600";
    title.style.marginBottom = "6px";

    const img = document.createElement("img");
    img.style.width = "100%";
    img.style.borderRadius = "10px";
    img.style.display = "block";
    if (s.thumbnail) img.src = s.thumbnail;

    card.onclick = async () => {
      selectedSourceId = s.id;
      log("Selected source:", s.id, s.name);
      await loadSources(); // re-render highlight
    };

    card.appendChild(title);
    card.appendChild(img);
    $sources.appendChild(card);
  }
}

async function captureSelectedSource() {
  if (!selectedSourceId) {
    alert("Pick a screen/window first.");
    return;
  }

  // This is the Electron way (works without HTTPS)
  screenStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: selectedSourceId,
        maxFrameRate: 60,
      },
    },
  });

  $preview.srcObject = screenStream;

  const [track] = screenStream.getVideoTracks();
  if (track) track.onended = () => stopAll();

  // attach/replace tracks in peers, then renegotiate
  for (const [viewerId, pc] of peers.entries()) {
    for (const sender of pc.getSenders()) {
      if (sender.track) pc.removeTrack(sender);
    }
    for (const t of screenStream.getTracks()) pc.addTrack(t, screenStream);
    await makeOffer(viewerId);
  }
}

function stopAll() {
  if (screenStream) {
    for (const t of screenStream.getTracks()) t.stop();
    screenStream = null;
  }
  $preview.srcObject = null;

  for (const [, pc] of peers) {
    try {
      pc.close();
    } catch {}
  }
  peers.clear();

  $start.disabled = false;
  $stop.disabled = true;
  log("Stopped streaming and closed peers.");
}

$connect.onclick = () => {
  const url = $server.value.trim();
  if (!url) return;

  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }

  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus("ws-open");
    log("WS connected:", url);
    send({ type: "join", role: "host" });

    $pick.disabled = false;
    $start.disabled = false;
  };

  ws.onclose = () => {
    setStatus("ws-closed");
    log("WS closed");
    $pick.disabled = true;
    $start.disabled = true;
    $stop.disabled = true;
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "viewer-joined") {
      log("Viewer joined:", msg.viewerId);
      ensurePeer(msg.viewerId);
      if (screenStream) await makeOffer(msg.viewerId);
    }

    if (msg.type === "viewer-left") {
      log("Viewer left:", msg.viewerId);
      const pc = peers.get(msg.viewerId);
      if (pc) {
        try {
          pc.close();
        } catch {}
      }
      peers.delete(msg.viewerId);
    }

    if (msg.type === "answer") {
      const pc = peers.get(msg.viewerId);
      if (!pc) return;
      await pc.setRemoteDescription(msg.sdp);
      log("Got answer from", msg.viewerId);
    }

    if (msg.type === "ice") {
      const pc = peers.get(msg.viewerId);
      if (!pc) return;
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        log("ICE add failed:", String(e));
      }
    }
  };
};

$pick.onclick = async () => {
  try {
    await loadSources();
  } catch (e) {
    log("getSources failed:", String(e));
    alert("Failed to load sources. Check preload + contextIsolation setup.");
  }
};

$start.onclick = async () => {
  try {
    await captureSelectedSource();
    $stop.disabled = false;
    $start.disabled = true;
    log("Streaming started.");
  } catch (e) {
    log("Capture failed:", String(e));
    alert(
      "Capture failed. Try selecting a different source (Screen 1) and ensure permissions.",
    );
  }
};

$stop.onclick = () => stopAll();
