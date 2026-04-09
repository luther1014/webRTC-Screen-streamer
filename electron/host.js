const $room = document.getElementById("room");
const $server = document.getElementById("server");
const $connect = document.getElementById("connect");
const $status = document.getElementById("status");
const $pick = document.getElementById("pick");
const $start = document.getElementById("start");
const $stop = document.getElementById("stop");
const $timerStart = document.getElementById("timerStart");
const $timerStop = document.getElementById("timerStop");
const $timerReset = document.getElementById("timerReset");
const $timerLimit = document.getElementById("timerLimit");
const $timerDisplay = document.getElementById("timerDisplay");
const $preview = document.getElementById("preview");
const $sources = document.getElementById("sources");
const $viewerLink = document.getElementById("viewerLink");
const $qrImage = document.getElementById("qrImage");
const $qrHint = document.getElementById("qrHint");
const $messagePanel = document.getElementById("messagePanel");
const $log = document.getElementById("log");

function log(...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  console.log(...args);
  if ($log) {
    $log.textContent += line + "\n";
    $log.scrollTop = $log.scrollHeight;
  }
}

function setStatus(text) {
  if ($status) $status.textContent = text;
}

function addViewerMessage(viewerId, emoji) {
  if (!$messagePanel) return;
  const time = new Date().toLocaleTimeString();
  const item = document.createElement("div");
  item.className = "chat-item";
  item.innerHTML = `<strong>Viewer ${viewerId?.slice(0, 6) || "?"}</strong>: ${emoji} <time>${time}</time>`;
  $messagePanel.prepend(item);
  while ($messagePanel.childElementCount > 50) {
    $messagePanel.removeChild($messagePanel.lastChild);
  }
}

let ws = null;
let screenStream = null;
let selectedSourceId = null;
let currentLanIp = null;

const peers = new Map(); // viewerId -> RTCPeerConnection

let timerInterval = null;
let timerStartTime = null;
let timerRunning = false;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      ...msg,
      roomId: ($room?.value || "demo").trim(),
    }),
  );
}

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function getTimerLimitSeconds() {
  if (!$timerLimit) return 0;
  const minutes = Number($timerLimit.value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.floor(minutes * 60);
}

function updateTimerDisplay() {
  if (timerRunning && timerStartTime) {
    const elapsed = Math.max(0, Math.floor((Date.now() - timerStartTime) / 1000));
    $timerDisplay.textContent = formatTime(elapsed);
  }
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  timerStartTime = Date.now();
  timerInterval = setInterval(updateTimerDisplay, 1000);
  send({ type: "timer-start", startTime: timerStartTime, limitSeconds: getTimerLimitSeconds() });
  $timerStart.disabled = true;
  $timerStop.disabled = false;
  if ($timerReset) $timerReset.disabled = false;
  log("Timer started");
}

function stopTimer() {
  if (!timerRunning) return;
  timerRunning = false;
  clearInterval(timerInterval);
  timerInterval = null;
  send({ type: "timer-stop" });
  $timerStart.disabled = false;
  $timerStop.disabled = true;
  if ($timerReset) $timerReset.disabled = false;
  log("Timer stopped");
}

function resetTimer() {
  timerRunning = false;
  timerStartTime = null;
  clearInterval(timerInterval);
  timerInterval = null;
  if ($timerDisplay) $timerDisplay.textContent = "00:00:00";
  send({ type: "timer-reset" });
  if ($timerStart) $timerStart.disabled = false;
  if ($timerStop) $timerStop.disabled = true;
  if ($timerReset) $timerReset.disabled = false;
  log("Timer reset");
}

function buildViewerUrl() {
  const room = encodeURIComponent(($room?.value || "demo").trim() || "demo");
  const ip = currentLanIp || "127.0.0.1";
  return `http://${ip}:8080/view?room=${room}`;
}

async function updateViewerUrlAndQr() {
  try {
    const url = buildViewerUrl();

    if ($viewerLink) $viewerLink.textContent = url;
    log("Generating QR for:", url);

    if (!window.electronAPI?.makeQRCodeDataUrl) {
      throw new Error("window.electronAPI.makeQRCodeDataUrl is not available");
    }

    const qrDataUrl = await window.electronAPI.makeQRCodeDataUrl(url);

    if ($qrImage) $qrImage.src = qrDataUrl;
    if ($qrHint) $qrHint.textContent = "Scan to open viewer page";

    log("QR generated successfully.");
  } catch (e) {
    log("QR generation failed:", String(e));
    if ($qrHint) $qrHint.textContent = "QR generation failed";
    if ($qrImage) $qrImage.removeAttribute("src");
  }
}

async function loadLanIp() {
  try {
    if (!window.electronAPI?.getLanIps) {
      throw new Error("window.electronAPI.getLanIps is not available");
    }

    const ips = await window.electronAPI.getLanIps();
    log("Detected LAN IPs:", ips);

    if (ips && ips.length > 0) {
      currentLanIp = ips[0];
    } else {
      currentLanIp = "127.0.0.1";
    }

    await updateViewerUrlAndQr();
  } catch (e) {
    log("LAN IP detection failed:", String(e));
    currentLanIp = "127.0.0.1";
    await updateViewerUrlAndQr();
  }
}

function ensurePeer(viewerId) {
  if (peers.has(viewerId)) return peers.get(viewerId);

  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: "ice", viewerId, candidate: e.candidate });
    }
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

  if (screenStream) {
    for (const track of screenStream.getTracks()) {
      pc.addTrack(track, screenStream);
    }
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

  send({
    type: "offer",
    viewerId,
    sdp: pc.localDescription,
  });

  log(`Sent offer -> ${viewerId}`);
}

async function loadSources() {
  if (!window.electronAPI?.getSources) {
    throw new Error("window.electronAPI.getSources is not available");
  }

  const sources = await window.electronAPI.getSources();
  $sources.innerHTML = "";

  for (const s of sources) {
    const card = document.createElement("button");
    card.type = "button";
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
    img.alt = s.name;
    if (s.thumbnail) img.src = s.thumbnail;

    card.onclick = async () => {
      selectedSourceId = s.id;
      log("Selected source:", s.id, s.name);
      await loadSources();
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

  if ($preview) $preview.srcObject = screenStream;

  const [track] = screenStream.getVideoTracks();
  if (track) {
    track.onended = () => stopAll();
  }

  for (const [viewerId, pc] of peers.entries()) {
    for (const sender of pc.getSenders()) {
      if (sender.track) {
        pc.removeTrack(sender);
      }
    }

    for (const t of screenStream.getTracks()) {
      pc.addTrack(t, screenStream);
    }

    await makeOffer(viewerId);
  }
}

function stopAll() {
  if (screenStream) {
    for (const t of screenStream.getTracks()) {
      t.stop();
    }
    screenStream = null;
  }

  if ($preview) $preview.srcObject = null;

  for (const [, pc] of peers) {
    try {
      pc.close();
    } catch {}
  }
  peers.clear();

  if ($start) $start.disabled = false;
  if ($stop) $stop.disabled = true;

  log("Stopped streaming and closed peers.");
}

function attachWsHandlers(socket) {
  socket.onopen = () => {
    setStatus("ws-open");
    log("WS connected:", $server.value.trim());
    send({ type: "join", role: "host" });

    if ($pick) $pick.disabled = false;
    if ($start) $start.disabled = false;
    if ($timerStart) $timerStart.disabled = false;
    if ($timerReset) $timerReset.disabled = false;
  };

  socket.onclose = () => {
    setStatus("ws-closed");
    log("WS closed");

    if ($pick) $pick.disabled = true;
    if ($start) $start.disabled = true;
    if ($stop) $stop.disabled = true;
    if ($timerStart) $timerStart.disabled = true;
    if ($timerStop) $timerStop.disabled = true;
    stopTimer(); // Stop timer on disconnect
  };

  socket.onerror = (err) => {
    log("WS error:", err?.message || "unknown websocket error");
  };

  socket.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "viewer-joined") {
      log("Viewer joined:", msg.viewerId);
      ensurePeer(msg.viewerId);
      if (screenStream) {
        await makeOffer(msg.viewerId);
      }
      return;
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
      return;
    }

    if (msg.type === "viewer-message") {
      log("Viewer message:", msg.viewerId, msg.emoji);
      addViewerMessage(msg.viewerId, msg.emoji);
      return;
    }

    if (msg.type === "answer") {
      const pc = peers.get(msg.viewerId);
      if (!pc) return;
      await pc.setRemoteDescription(msg.sdp);
      log("Got answer from", msg.viewerId);
      return;
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
}

if ($room) {
  $room.addEventListener("input", () => {
    updateViewerUrlAndQr();
  });
}

if ($connect) {
  $connect.onclick = () => {
    const url = ($server?.value || "").trim();
    if (!url) return;

    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }

    log("Connecting WS to:", url);
    ws = new WebSocket(url);
    attachWsHandlers(ws);
  };
}

if ($pick) {
  $pick.onclick = async () => {
    try {
      await loadSources();
    } catch (e) {
      log("getSources failed:", String(e));
      alert("Failed to load sources. Check preload.js and Electron setup.");
    }
  };
}

if ($start) {
  $start.onclick = async () => {
    try {
      await captureSelectedSource();
      $stop.disabled = false;
      $start.disabled = true;
      log("Streaming started.");
    } catch (e) {
      log("Capture failed:", String(e));
      alert(
        "Capture failed. Try selecting a different source and check permissions.",
      );
    }
  };
}

if ($stop) {
  $stop.onclick = () => stopAll();
}

if ($timerStart) {
  $timerStart.onclick = () => startTimer();
}

if ($timerStop) {
  $timerStop.onclick = () => stopTimer();
}

if ($timerReset) {
  $timerReset.onclick = () => resetTimer();
}

window.addEventListener("DOMContentLoaded", async () => {
  log("DOM loaded.");
  log("electronAPI available:", !!window.electronAPI);
  log("getSources available:", !!window.electronAPI?.getSources);
  log("getLanIps available:", !!window.electronAPI?.getLanIps);
  log("makeQRCodeDataUrl available:", !!window.electronAPI?.makeQRCodeDataUrl);

  await loadLanIp();
});
