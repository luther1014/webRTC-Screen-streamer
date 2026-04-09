const $room = document.getElementById("room");
const $roomKey = document.getElementById("roomKey");
const $server = document.getElementById("server");
const $connect = document.getElementById("connect");
const $status = document.getElementById("status");
const $statusChip = document.getElementById("statusChip");
const $hostStateLabel = document.getElementById("hostStateLabel");
const $roomMirror = document.getElementById("roomMirror");
const $roomKeyMirror = document.getElementById("roomKeyMirror");
const $viewerCount = document.getElementById("viewerCount");
const $sourceCount = document.getElementById("sourceCount");
const $selectedSourceName = document.getElementById("selectedSourceName");
const $selectedSourceBadge = document.getElementById("selectedSourceBadge");
const $lanIpLabel = document.getElementById("lanIpLabel");
const $reactionOverlay = document.getElementById("reactionOverlay");
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

function notifyHostSystem(title, body) {
  if (!window.electronAPI?.notifyHostSystem) return;
  window.electronAPI.notifyHostSystem({ title, body });
}

function setStatus(text) {
  const normalized = String(text || "idle");
  if ($status) $status.textContent = normalized;
  if ($hostStateLabel) {
    $hostStateLabel.textContent = normalized.replace(/-/g, " ");
  }

  if ($statusChip) {
    const label = normalized.replace(/-/g, " ");
    $statusChip.textContent = label.charAt(0).toUpperCase() + label.slice(1);
    $statusChip.classList.remove("status-idle", "status-good", "status-warn");

    if (["connected", "streaming", "waiting-viewers"].includes(normalized)) {
      $statusChip.classList.add("status-good");
    } else if (
      ["replaced", "join-denied", "ws-closed", "capture-failed"].includes(
        normalized,
      )
    ) {
      $statusChip.classList.add("status-warn");
    } else {
      $statusChip.classList.add("status-idle");
    }
  }
}

function updateSessionMirrors() {
  if ($roomMirror) {
    $roomMirror.textContent = getRoomId();
  }
  if ($roomKeyMirror) {
    const key = getRoomKey();
    $roomKeyMirror.textContent = key || "------";
  }
}

function updateViewerCount() {
  if ($viewerCount) {
    const count = activeViewerIds.size;
    $viewerCount.textContent = `${count} viewer${count === 1 ? "" : "s"}`;
  }
}

function updateSelectedSourceUI() {
  const label = selectedSourceName || "No source selected yet.";
  if ($selectedSourceName) {
    $selectedSourceName.textContent = label;
  }
  if ($selectedSourceBadge) {
    $selectedSourceBadge.textContent =
      selectedSourceName || "No source selected";
  }
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

function showHostToast({
  icon = "\u2022",
  title = "Session update",
  subtitle = "",
  tone = "info",
} = {}) {
  if (!$reactionOverlay) return;

  const toast = document.createElement("div");
  toast.className = `reaction-toast reaction-toast--${tone}`;
  toast.innerHTML = `
    <span class="reaction-toast__emoji">${icon}</span>
    <div class="reaction-toast__copy">
      <strong>${title}</strong>
      <span>${subtitle}</span>
    </div>
  `;

  $reactionOverlay.prepend(toast);

  const removeToast = () => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  };

  const exitTimer = setTimeout(() => {
    toast.classList.add("reaction-toast--exit");
  }, 2600);

  const cleanupTimer = setTimeout(removeToast, 3200);

  toast.addEventListener(
    "animationend",
    (event) => {
      if (event.animationName === "reaction-toast-out") {
        clearTimeout(exitTimer);
        clearTimeout(cleanupTimer);
        removeToast();
      }
    },
    { once: true },
  );

  while ($reactionOverlay.childElementCount > 4) {
    $reactionOverlay.removeChild($reactionOverlay.lastChild);
  }
}

function showReactionOverlay(viewerId, emoji) {
  const shortViewerId = viewerId?.slice(0, 6) || "Unknown";
  showHostToast({
    icon: emoji || "?",
    title: `Viewer ${shortViewerId}`,
    subtitle: "sent a live reaction",
    tone: "info",
  });
  notifyHostSystem(
    `Reaction from viewer ${shortViewerId}`,
    `${emoji || "Reaction"} received in the live session.`,
  );
}

function notifyViewerDisconnect(viewerId, subtitle, tone = "warn") {
  const normalizedViewerId = viewerId || "unknown";
  if (viewerDisconnectAlerts.has(normalizedViewerId)) return;
  viewerDisconnectAlerts.add(normalizedViewerId);

  showHostToast({
    icon: tone === "warn" ? "\u26A0" : "\u2139",
    title: `Viewer ${normalizedViewerId.slice(0, 6)} disconnected`,
    subtitle,
    tone,
  });
  notifyHostSystem(
    `Viewer ${normalizedViewerId.slice(0, 6)} disconnected`,
    subtitle,
  );

  setTimeout(() => {
    viewerDisconnectAlerts.delete(normalizedViewerId);
  }, 5000);
}

function describeJoinReason(reason) {
  if (reason === "room-key-required") return "Room key required";
  if (reason === "invalid-room-key") return "Invalid room key";
  if (reason === "viewer-id-required") return "Viewer id required";
  return reason || "join-denied";
}

function randomRoomKey() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getRoomId() {
  return ($room?.value || "demo").trim() || "demo";
}

function normalizeRoomKeyInput() {
  if (!$roomKey) return "";
  $roomKey.value = $roomKey.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return $roomKey.value;
}

function getRoomKey() {
  return normalizeRoomKeyInput().trim();
}

let ws = null;
let screenStream = null;
let selectedSourceId = null;
let selectedSourceName = "";
let currentLanIp = null;
let joinedAsHost = false;
let canPickSources = false;

const peers = new Map();
const activeViewerIds = new Set();
const viewerDisconnectAlerts = new Set();

let timerInterval = null;
let timerStartTime = null;
let timerRunning = false;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setHostControlsEnabled(enabled) {
  if ($start) $start.disabled = !enabled;
  if ($stop) $stop.disabled = true;
  if ($timerStart) $timerStart.disabled = !enabled;
  if ($timerStop) $timerStop.disabled = true;
  if ($timerReset) $timerReset.disabled = !enabled;
}

function syncPickButton() {
  if ($pick) $pick.disabled = !canPickSources;
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      ...msg,
      roomId: getRoomId(),
    }),
  );
}

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function getTimerLimitSeconds() {
  if (!$timerLimit) return 0;
  const minutes = Number($timerLimit.value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.floor(minutes * 60);
}

function updateTimerDisplay() {
  if (timerRunning && timerStartTime) {
    const elapsed = Math.max(
      0,
      Math.floor((Date.now() - timerStartTime) / 1000),
    );
    $timerDisplay.textContent = formatTime(elapsed);
  }
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  timerStartTime = Date.now();
  timerInterval = setInterval(updateTimerDisplay, 1000);
  send({
    type: "timer-start",
    startTime: timerStartTime,
    limitSeconds: getTimerLimitSeconds(),
  });
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
  if (joinedAsHost) {
    $timerStart.disabled = false;
    $timerStop.disabled = true;
    if ($timerReset) $timerReset.disabled = false;
  }
  log("Timer stopped");
}

function resetTimer() {
  timerRunning = false;
  timerStartTime = null;
  clearInterval(timerInterval);
  timerInterval = null;
  if ($timerDisplay) $timerDisplay.textContent = "00:00:00";
  send({ type: "timer-reset" });
  if (joinedAsHost) {
    if ($timerStart) $timerStart.disabled = false;
    if ($timerStop) $timerStop.disabled = true;
    if ($timerReset) $timerReset.disabled = false;
  }
  log("Timer reset");
}

function buildViewerUrl() {
  const room = encodeURIComponent(getRoomId());
  const roomKey = encodeURIComponent(getRoomKey());
  const ip = currentLanIp || "127.0.0.1";
  return `http://${ip}:8080/view?room=${room}&key=${roomKey}`;
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
    if ($lanIpLabel) {
      $lanIpLabel.textContent = currentLanIp;
    }

    await updateViewerUrlAndQr();
  } catch (e) {
    log("LAN IP detection failed:", String(e));
    currentLanIp = "127.0.0.1";
    if ($lanIpLabel) {
      $lanIpLabel.textContent = currentLanIp;
    }
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
      if (
        screenStream &&
        activeViewerIds.has(viewerId) &&
        ["failed", "disconnected"].includes(pc.connectionState)
      ) {
        notifyViewerDisconnect(
          viewerId,
          "The live connection dropped before the viewer fully left the room.",
        );
      }
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
  if ($sourceCount) {
    $sourceCount.textContent = `${sources.length} source${sources.length === 1 ? "" : "s"}`;
  }
  $sources.innerHTML = "";

  for (const source of sources) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `source-card${selectedSourceId === source.id ? " source-card--selected" : ""}`;

    const title = document.createElement("div");
    title.className = "source-card__title";
    title.textContent = source.name;

    const img = document.createElement("img");
    img.className = "source-card__thumb";
    img.alt = source.name;
    if (source.thumbnail) img.src = source.thumbnail;

    card.onclick = async () => {
      selectedSourceId = source.id;
      selectedSourceName = source.name;
      updateSelectedSourceUI();
      log("Selected source:", source.id, source.name);
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

    for (const streamTrack of screenStream.getTracks()) {
      pc.addTrack(streamTrack, screenStream);
    }

    await makeOffer(viewerId);
  }
}

function stopAll() {
  if (screenStream) {
    for (const track of screenStream.getTracks()) {
      track.stop();
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
  activeViewerIds.clear();
  viewerDisconnectAlerts.clear();
  updateViewerCount();

  if ($stop) $stop.disabled = true;
  if ($start) $start.disabled = !joinedAsHost;

  log("Stopped streaming and closed peers.");
}

function disconnectHostSocket(closeStatus = null) {
  joinedAsHost = false;
  if (!ws) return;
  const socket = ws;
  ws = null;
  socket.codexCloseStatus = closeStatus;
  try {
    socket.close();
  } catch {}
}

function attachWsHandlers(socket) {
  socket.onopen = () => {
    if (socket !== ws) return;
    setStatus("joining");
    log("WS connected:", $server.value.trim());
    socket.send(
      JSON.stringify({
        type: "join",
        role: "host",
        roomId: getRoomId(),
        roomKey: getRoomKey(),
      }),
    );
  };

  socket.onclose = () => {
    if (socket !== ws && ws !== null) return;
    const closeStatus = socket.codexCloseStatus || "ws-closed";
    ws = null;
    joinedAsHost = false;
    setStatus(closeStatus);
    log("WS closed");
    stopAll();
    stopTimer();
    setHostControlsEnabled(false);
  };

  socket.onerror = (err) => {
    if (socket !== ws) return;
    log("WS error:", err?.message || "unknown websocket error");
  };

  socket.onmessage = async (ev) => {
    if (socket !== ws) return;
    const msg = JSON.parse(ev.data);

    if (msg.type === "joined") {
      joinedAsHost = true;
      setStatus("connected");
      setHostControlsEnabled(true);
      updateViewerCount();
      log("Joined room as host:", getRoomId());
      return;
    }

    if (msg.type === "join-denied") {
      setStatus("join-denied");
      log("Join denied:", describeJoinReason(msg.reason));
      setHostControlsEnabled(false);
      disconnectHostSocket("join-denied");
      return;
    }

    if (msg.type === "replaced") {
      setStatus("replaced");
      log("Another host took over this room.");
      stopAll();
      stopTimer();
      setHostControlsEnabled(false);
      disconnectHostSocket("replaced");
      return;
    }

    if (msg.type === "viewer-joined") {
      log("Viewer joined:", msg.viewerId);
      activeViewerIds.add(msg.viewerId);
      viewerDisconnectAlerts.delete(msg.viewerId);
      updateViewerCount();
      ensurePeer(msg.viewerId);
      setStatus(screenStream ? "streaming" : "waiting-viewers");
      if (screenStream) {
        await makeOffer(msg.viewerId);
      }
      return;
    }

    if (msg.type === "viewer-left") {
      log("Viewer left:", msg.viewerId);
      notifyViewerDisconnect(
        msg.viewerId,
        "They left the room or their connection dropped.",
      );
      activeViewerIds.delete(msg.viewerId);
      updateViewerCount();
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
      showReactionOverlay(msg.viewerId, msg.emoji);
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
    updateSessionMirrors();
    updateViewerUrlAndQr();
  });
}

if ($roomKey) {
  $roomKey.addEventListener("input", () => {
    normalizeRoomKeyInput();
    updateSessionMirrors();
    updateViewerUrlAndQr();
  });
}

if ($connect) {
  $connect.onclick = () => {
    const url = ($server?.value || "").trim();
    const roomKey = getRoomKey();
    if (!url || !roomKey) {
      setStatus("join-denied");
      log("Connect aborted: missing server URL or room key.");
      return;
    }

    disconnectHostSocket("idle");
    setHostControlsEnabled(false);

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
      setStatus("streaming");
      log("Streaming started.");
    } catch (e) {
      setStatus("capture-failed");
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

  canPickSources = !!window.electronAPI?.getSources;
  syncPickButton();

  if ($roomKey && !$roomKey.value) {
    $roomKey.value = randomRoomKey();
  }
  normalizeRoomKeyInput();
  updateSessionMirrors();
  updateViewerCount();
  updateSelectedSourceUI();

  await loadLanIp();
});
