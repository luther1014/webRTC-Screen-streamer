import { qs, randomId, wsUrl, log } from "./common.js";

const roomId = qs("room") || "demo";
const viewerId = qs("id") || randomId();

const $room = document.getElementById("room");
const $status = document.getElementById("status");
const $video = document.getElementById("video");
const $timerOverlay = document.getElementById("timerOverlay");
const $timerText = document.getElementById("timerText");
const $log = document.getElementById("log");
const $emojiButtons = document.querySelectorAll(".emoji-btn");
const $darkModeToggle = document.getElementById("darkModeToggle");

$room.textContent = roomId;

let pc = null;
let timerInterval = null;
let timerStartTime = null;
let timerLimitSeconds = 0;
const socket = new WebSocket(wsUrl());

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateTimerDisplay() {
  if (!timerStartTime) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - timerStartTime) / 1000));
  $timerText.textContent = formatTime(elapsed);
  if (timerLimitSeconds > 0 && elapsed >= timerLimitSeconds) {
    $timerOverlay.style.background = 'rgba(255,200,200,0.9)';
    $timerOverlay.style.color = '#000';
  } else {
    $timerOverlay.style.background = 'rgba(0,0,0,0.7)';
    $timerOverlay.style.color = '#fff';
  }
}

function startViewerTimer(startTime, limitSeconds = 0) {
  timerStartTime = startTime;
  timerLimitSeconds = Number.isFinite(limitSeconds) ? limitSeconds : 0;
  $timerOverlay.style.display = 'block';
  updateTimerDisplay();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopViewerTimer() {
  timerStartTime = null;
  timerLimitSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = null;
  $timerOverlay.style.display = 'none';
  $timerOverlay.style.background = 'rgba(0,0,0,0.7)';
  $timerOverlay.style.color = '#fff';
}

function resetViewerTimer() {
  timerStartTime = null;
  timerLimitSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = null;
  $timerOverlay.style.display = 'none';
  $timerText.textContent = '00:00:00';
  $timerOverlay.style.background = 'rgba(0,0,0,0.7)';
  $timerOverlay.style.color = '#fff';
}

function setStatus(s) {
  $status.textContent = s;
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
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ ...msg, roomId, viewerId }));
}
function sendViewerEmoji(emoji) {
  if (socket.readyState !== WebSocket.OPEN) {
    log($log, "Cannot send emoji before WS is open.");
    return;
  }
  send({ type: "viewer-message", emoji });
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

socket.onopen = () => {
  log($log, "WS connected. Joining as viewer", { viewerId });
  send({ type: "join", role: "viewer" });
  setStatus("waiting-host");
};

socket.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === "host-ready") {
    log($log, "Host ready. Waiting for offer...");
    setStatus("host-ready");
  }

  if (msg.type === "host-left") {
    log($log, "Host left.");
    setStatus("host-left");
    if (pc) {
      try {
        pc.close();
      } catch {}
      pc = null;
    }
    $video.srcObject = null;
  }

  if (msg.type === "offer") {
    ensurePc();
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "answer", sdp: pc.localDescription });
    log($log, "Answered offer.");
    setStatus("negotiating");
  }

  if (msg.type === "ice") {
    ensurePc();
    try {
      await pc.addIceCandidate(msg.candidate);
    } catch (e) {
      log($log, "ICE add failed:", String(e));
    }
  }

  if (msg.type === "timer-start") {
    startViewerTimer(msg.startTime, msg.limitSeconds);
  }

  if (msg.type === "timer-stop") {
    stopViewerTimer();
  }

  if (msg.type === "timer-reset") {
    resetViewerTimer();
  }
};
