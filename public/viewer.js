import { qs, randomId, wsUrl, log } from "./common.js";

const roomId = qs("room") || "demo";
const viewerId = qs("id") || randomId();
const initialRoomKey = qs("key") || "";

const $room = document.getElementById("room");
const $roomKey = document.getElementById("roomKey");
const $connectBtn = document.getElementById("connectBtn");
const $connectionHint = document.getElementById("connectionHint");
const $status = document.getElementById("status");
const $video = document.getElementById("video");
const $timerOverlay = document.getElementById("timerOverlay");
const $timerText = document.getElementById("timerText");
const $log = document.getElementById("log");
const $emojiButtons = document.querySelectorAll(".emoji-btn");
const $darkModeToggle = document.getElementById("darkModeToggle");

$room.textContent = roomId;
if ($roomKey) $roomKey.value = initialRoomKey.toUpperCase();

let pc = null;
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let timerInterval = null;
let timerStartTime = null;
let timerLimitSeconds = 0;
let joinedViewer = false;
let manuallyClosed = false;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function normalizeRoomKeyInput() {
  if (!$roomKey) return "";
  $roomKey.value = $roomKey.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return $roomKey.value;
}

function getRoomKey() {
  return normalizeRoomKeyInput().trim();
}

function describeJoinReason(reason) {
  if (reason === "room-key-required") return "Room key required";
  if (reason === "invalid-room-key") return "Invalid room key";
  if (reason === "viewer-id-required") return "Viewer id required";
  return reason || "join-denied";
}

function setStatus(status) {
  $status.textContent = status;
}

function setHint(text) {
  if ($connectionHint) $connectionHint.textContent = text;
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function resetPeer() {
  if (pc) {
    try {
      pc.close();
    } catch {}
    pc = null;
  }
  $video.srcObject = null;
}

function scheduleReconnect() {
  if (manuallyClosed || !joinedViewer) return;
  clearReconnect();
  reconnectAttempt += 1;
  const delay = Math.min(5000, 1000 * reconnectAttempt);
  setStatus("reconnecting");
  setHint(`Connection lost. Retrying in ${Math.ceil(delay / 1000)}s.`);
  reconnectTimer = setTimeout(() => {
    log($log, "Retrying signaling connection.");
    connectSocket();
  }, delay);
}

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function updateTimerDisplay() {
  if (!timerStartTime) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - timerStartTime) / 1000));
  $timerText.textContent = formatTime(elapsed);
  if (timerLimitSeconds > 0 && elapsed >= timerLimitSeconds) {
    $timerOverlay.style.background = "rgba(255,200,200,0.9)";
    $timerOverlay.style.color = "#000";
  } else {
    $timerOverlay.style.background = "rgba(0,0,0,0.7)";
    $timerOverlay.style.color = "#fff";
  }
}

function startViewerTimer(startTime, limitSeconds = 0) {
  timerStartTime = startTime;
  timerLimitSeconds = Number.isFinite(limitSeconds) ? limitSeconds : 0;
  $timerOverlay.style.display = "block";
  updateTimerDisplay();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopViewerTimer() {
  timerStartTime = null;
  timerLimitSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = null;
  $timerOverlay.style.display = "none";
  $timerOverlay.style.background = "rgba(0,0,0,0.7)";
  $timerOverlay.style.color = "#fff";
}

function resetViewerTimer() {
  timerStartTime = null;
  timerLimitSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = null;
  $timerOverlay.style.display = "none";
  $timerText.textContent = "00:00:00";
  $timerOverlay.style.background = "rgba(0,0,0,0.7)";
  $timerOverlay.style.color = "#fff";
}

function setDarkMode(enabled) {
  document.body.classList.toggle("dark-mode", enabled);
  if ($darkModeToggle) {
    $darkModeToggle.textContent = enabled ? "☀️" : "🌙";
  }
  localStorage.setItem("viewerDarkMode", enabled ? "1" : "0");
}

function toggleDarkMode() {
  setDarkMode(!document.body.classList.contains("dark-mode"));
}

if ($darkModeToggle) {
  $darkModeToggle.addEventListener("click", toggleDarkMode);
}

const savedDarkMode = localStorage.getItem("viewerDarkMode");
if (savedDarkMode === "1") {
  setDarkMode(true);
}

function send(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(
    JSON.stringify({
      ...msg,
      roomId,
      viewerId,
    }),
  );
  return true;
}

function sendViewerEmoji(emoji) {
  if (!joinedViewer) {
    log($log, "Cannot send emoji before joining the room.");
    return;
  }
  if (!send({ type: "viewer-message", emoji })) {
    log($log, "Cannot send emoji before WS is open.");
    return;
  }
  log($log, "Sent emoji:", emoji);
}

$emojiButtons.forEach((button) => {
  button.addEventListener("click", () => {
    sendViewerEmoji(button.dataset.emoji);
  });
});

function ensurePc() {
  if (pc) return pc;

  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "ice", candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    if ($video.srcObject !== e.streams[0]) {
      $video.srcObject = e.streams[0];
      log($log, "Received remote stream.");
    }
  };

  pc.onconnectionstatechange = () => {
    setStatus(pc.connectionState);
    log($log, "pc state=", pc.connectionState);
  };

  return pc;
}

function closeSocket({ manual = false } = {}) {
  manuallyClosed = manual;
  clearReconnect();
  if (!socket) return;
  const activeSocket = socket;
  socket = null;
  try {
    activeSocket.close();
  } catch {}
}

function connectSocket() {
  const roomKey = getRoomKey();
  if (!roomKey) {
    setStatus("room-key-required");
    setHint("Enter the room key shared by the host.");
    log($log, "Connection blocked: room key missing.");
    return;
  }

  clearReconnect();
  if (socket) {
    closeSocket({ manual: true });
  }

  manuallyClosed = false;
  joinedViewer = false;
  resetPeer();
  setStatus("connecting");
  setHint("Connecting to the signaling server...");
  log($log, "Connecting to signaling server.");

  const activeSocket = new WebSocket(wsUrl());
  socket = activeSocket;

  activeSocket.onopen = () => {
    if (socket !== activeSocket) return;
    setStatus("joining");
    setHint("Sending join request to the host room.");
    activeSocket.send(
      JSON.stringify({
        type: "join",
        role: "viewer",
        roomId,
        viewerId,
        roomKey,
      }),
    );
  };

  activeSocket.onmessage = async (ev) => {
    if (socket !== activeSocket) return;
    const msg = JSON.parse(ev.data);

    if (msg.type === "joined") {
      joinedViewer = true;
      reconnectAttempt = 0;
      setStatus(msg.waitingForHost ? "waiting-host" : "connected");
      setHint(
        msg.waitingForHost
          ? "Connected. Waiting for the host to start streaming."
          : "Connected. Waiting for the next stream update.",
      );
      log($log, "Joined room as viewer", { viewerId });
      return;
    }

    if (msg.type === "join-denied") {
      joinedViewer = false;
      manuallyClosed = true;
      setStatus("join-denied");
      setHint(describeJoinReason(msg.reason));
      log($log, "Join denied:", describeJoinReason(msg.reason));
      closeSocket({ manual: true });
      return;
    }

    if (msg.type === "replaced") {
      joinedViewer = false;
      manuallyClosed = true;
      setStatus("replaced");
      setHint("Another viewer session replaced this tab.");
      log($log, "This viewer session was replaced.");
      resetPeer();
      closeSocket({ manual: true });
      return;
    }

    if (msg.type === "host-ready") {
      log($log, "Host ready. Waiting for offer...");
      setStatus("host-ready");
      setHint("Host is ready. Waiting for the video stream.");
      return;
    }

    if (msg.type === "host-left") {
      log($log, "Host left.");
      setStatus("host-left");
      setHint("Host disconnected. Waiting for them to reconnect.");
      resetPeer();
      return;
    }

    if (msg.type === "offer") {
      ensurePc();
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", sdp: pc.localDescription });
      log($log, "Answered offer.");
      setStatus("negotiating");
      setHint("Negotiating the WebRTC connection.");
      return;
    }

    if (msg.type === "ice") {
      ensurePc();
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (e) {
        log($log, "ICE add failed:", String(e));
      }
      return;
    }

    if (msg.type === "timer-start") {
      startViewerTimer(msg.startTime, msg.limitSeconds);
      return;
    }

    if (msg.type === "timer-stop") {
      stopViewerTimer();
      return;
    }

    if (msg.type === "timer-reset") {
      resetViewerTimer();
    }
  };

  activeSocket.onclose = () => {
    if (socket !== activeSocket && socket !== null) return;
    socket = null;
    resetPeer();
    if (joinedViewer && !manuallyClosed) {
      log($log, "Signaling connection closed unexpectedly.");
      scheduleReconnect();
      return;
    }
    if (!manuallyClosed) {
      setStatus("ws-closed");
      setHint("Socket closed. Press Connect to try again.");
    }
  };

  activeSocket.onerror = () => {
    if (socket !== activeSocket) return;
    log($log, "WebSocket error.");
    setHint("Socket error. Waiting for the connection state to settle.");
  };
}

if ($roomKey) {
  $roomKey.addEventListener("input", () => {
    normalizeRoomKeyInput();
  });

  $roomKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      connectSocket();
    }
  });
}

if ($connectBtn) {
  $connectBtn.addEventListener("click", () => {
    connectSocket();
  });
}

window.addEventListener("beforeunload", () => {
  closeSocket({ manual: true });
  clearInterval(timerInterval);
});

if (initialRoomKey) {
  connectSocket();
}
