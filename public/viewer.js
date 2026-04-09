import { qs, randomId, wsUrl, log } from "./common.js";

const roomId = qs("room") || "demo";
const viewerId = qs("id") || randomId();
const initialRoomKey = qs("key") || "";

const $room = document.getElementById("room");
const $viewerIdLabel = document.getElementById("viewerIdLabel");
const $roomKey = document.getElementById("roomKey");
const $connectBtn = document.getElementById("connectBtn");
const $connectionHint = document.getElementById("connectionHint");
const $status = document.getElementById("status");
const $viewerStatusChip = document.getElementById("viewerStatusChip");
const $streamStateLabel = document.getElementById("streamStateLabel");
const $stageTag = document.getElementById("stageTag");
const $viewerStageFrame = document.getElementById("viewerStageFrame");
const $video = document.getElementById("video");
const $emptyState = document.getElementById("emptyState");
const $fullscreenToggle = document.getElementById("fullscreenToggle");
const $timerOverlay = document.getElementById("timerOverlay");
const $timerStatus = document.getElementById("timerStatus");
const $timerText = document.getElementById("timerText");
const $timerMeta = document.getElementById("timerMeta");
const $timerProgress = document.getElementById("timerProgress");
const $viewerToastStack = document.getElementById("viewerToastStack");
const $log = document.getElementById("log");
const $emojiButtons = document.querySelectorAll(".emoji-btn");
const $darkModeToggle = document.getElementById("darkModeToggle");

$room.textContent = roomId;
if ($viewerIdLabel) $viewerIdLabel.textContent = viewerId.slice(0, 8);
if ($roomKey) $roomKey.value = initialRoomKey.toUpperCase();

let pc = null;
let socket = null;
let reconnectTimer = null;
let streamRecoveryTimer = null;
let reconnectAttempt = 0;
let timerInterval = null;
let timerStartTime = null;
let timerLimitSeconds = 0;
let joinedViewer = false;
let manuallyClosed = false;
let timerElapsedNotified = false;
let hasLiveStream = false;

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

function formatStatusLabel(value) {
  const normalized = String(value || "idle").replace(/-/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function setStatus(status) {
  $status.textContent = status;
  if ($viewerStatusChip) {
    $viewerStatusChip.textContent = formatStatusLabel(status);
    $viewerStatusChip.classList.remove(
      "status-idle",
      "status-good",
      "status-warn",
    );

    if (["connected", "host-ready", "connected-live"].includes(status)) {
      $viewerStatusChip.classList.add("status-good");
    } else if (
      ["join-denied", "host-left", "replaced", "ws-closed"].includes(status)
    ) {
      $viewerStatusChip.classList.add("status-warn");
    } else {
      $viewerStatusChip.classList.add("status-idle");
    }
  }
}

function setHint(text) {
  if ($connectionHint) $connectionHint.textContent = text;
}

function setStreamState(text, tag = text) {
  if ($streamStateLabel) $streamStateLabel.textContent = text;
  if ($stageTag) $stageTag.textContent = tag;
}

function setConnectButtonLabel(text) {
  if ($connectBtn) $connectBtn.textContent = text;
}

function syncEmptyState() {
  if (!$emptyState || !$video) return;
  const hasStream = !!$video.srcObject;
  $emptyState.style.display = hasStream ? "none" : "grid";
  $video.classList.toggle("video-live", hasStream);
}

function clearStreamRecovery() {
  if (streamRecoveryTimer) {
    clearTimeout(streamRecoveryTimer);
    streamRecoveryTimer = null;
  }
}

function scheduleStreamRecovery({
  delay = 1800,
  title = "Recovering stream",
  message = "Trying to restore the live feed.",
} = {}) {
  if (
    streamRecoveryTimer ||
    manuallyClosed ||
    !joinedViewer ||
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  setHint(message);
  showViewerToast(title, message, "warn");

  streamRecoveryTimer = window.setTimeout(() => {
    streamRecoveryTimer = null;
    if (
      manuallyClosed ||
      !joinedViewer ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    log($log, "Media session stalled. Rejoining room to recover the stream.");
    setStatus("recovering-stream");
    setStreamState("Recovering live stream", "Recovering");
    setConnectButtonLabel("Recovering...");
    setHint("Rejoining the host room to restore the stream.");
    closeSocket({ manual: false });
  }, delay);
}

function isViewerStageFullscreen() {
  return document.fullscreenElement === $viewerStageFrame;
}

function syncFullscreenButton() {
  if (!$fullscreenToggle) return;
  const active = isViewerStageFullscreen();
  $fullscreenToggle.textContent = active ? "Exit" : "Expand";
  $fullscreenToggle.setAttribute(
    "aria-label",
    active ? "Exit full screen" : "Enter full screen",
  );
  $fullscreenToggle.title = active ? "Exit full screen" : "Enter full screen";
  $fullscreenToggle.classList.toggle("viewer-frame-toggle--active", active);
}

async function toggleViewerFullscreen() {
  if (!$viewerStageFrame || !document.fullscreenEnabled) {
    showViewerToast(
      "Fullscreen unavailable",
      "This device does not allow fullscreen for the viewer frame.",
      "warn",
    );
    return;
  }

  try {
    if (isViewerStageFullscreen()) {
      await document.exitFullscreen();
    } else {
      await $viewerStageFrame.requestFullscreen();
    }
  } catch (error) {
    log($log, "Fullscreen toggle failed:", String(error));
    showViewerToast(
      "Fullscreen failed",
      "The viewer could not enter fullscreen mode.",
      "error",
    );
  }
}

function showViewerToast(title, message = "", tone = "info") {
  if (!$viewerToastStack) return;

  const toast = document.createElement("article");
  toast.className = `viewer-toast viewer-toast--${tone}`;

  const strong = document.createElement("strong");
  strong.textContent = title;
  toast.appendChild(strong);

  if (message) {
    const body = document.createElement("p");
    body.textContent = message;
    toast.appendChild(body);
  }

  $viewerToastStack.appendChild(toast);

  while ($viewerToastStack.children.length > 3) {
    $viewerToastStack.firstElementChild?.remove();
  }

  const dismiss = () => {
    toast.classList.add("viewer-toast--exit");
    window.setTimeout(() => toast.remove(), 260);
  };

  window.setTimeout(dismiss, 3200);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function resetPeer() {
  clearStreamRecovery();
  if (pc) {
    try {
      pc.close();
    } catch {}
    pc = null;
  }
  hasLiveStream = false;
  $video.srcObject = null;
  syncEmptyState();
}

function scheduleReconnect() {
  if (manuallyClosed || !joinedViewer) return;
  clearReconnect();
  reconnectAttempt += 1;
  const delay = Math.min(5000, 1000 * reconnectAttempt);
  setStatus("reconnecting");
  setStreamState("Reconnecting to signal", "Reconnecting");
  setConnectButtonLabel("Reconnect");
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

function formatDurationLabel(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function setTimerOverlayMode(mode) {
  if (!$timerOverlay) return;
  $timerOverlay.classList.remove(
    "timer-overlay--idle",
    "timer-overlay--open",
    "timer-overlay--unlimited",
    "timer-overlay--warning",
    "timer-overlay--elapsed",
  );
  $timerOverlay.classList.add(`timer-overlay--${mode}`);
}

function renderTimerOverlay(elapsedSeconds) {
  if (!$timerOverlay || !$timerText) return;

  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  const hasLimit = timerLimitSeconds > 0;
  const remaining = hasLimit ? Math.max(0, timerLimitSeconds - elapsed) : 0;
  const isElapsed = hasLimit && elapsed >= timerLimitSeconds;
  const warningThreshold = hasLimit
    ? Math.min(60, Math.max(10, Math.floor(timerLimitSeconds * 0.15)))
    : 0;
  const isWarning =
    hasLimit &&
    !isElapsed &&
    remaining <= warningThreshold;

  $timerText.textContent = formatTime(elapsed);

  if ($timerStatus) {
    $timerStatus.textContent = isElapsed
      ? "Elapsed"
      : isWarning
        ? "Closing"
        : hasLimit
          ? "Running"
          : "Live";
  }

  if ($timerMeta) {
    if (isElapsed) {
      $timerMeta.textContent = `${formatDurationLabel(elapsed - timerLimitSeconds)} over the ${formatDurationLabel(timerLimitSeconds)} limit`;
    } else if (hasLimit) {
      $timerMeta.textContent = `${formatDurationLabel(remaining)} remaining of ${formatDurationLabel(timerLimitSeconds)}`;
    } else {
      $timerMeta.textContent = "No limit set for this session timer";
    }
  }

  if ($timerProgress) {
    const progress = hasLimit
      ? Math.min(100, (elapsed / timerLimitSeconds) * 100)
      : 36;
    $timerProgress.style.width = `${progress}%`;
  }

  if (isElapsed) {
    setTimerOverlayMode("elapsed");
  } else if (isWarning) {
    setTimerOverlayMode("warning");
  } else if (hasLimit) {
    setTimerOverlayMode("open");
  } else {
    setTimerOverlayMode("unlimited");
  }
}

function updateTimerDisplay() {
  if (timerStartTime == null) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - timerStartTime) / 1000));
  renderTimerOverlay(elapsed);
  if (timerLimitSeconds > 0 && elapsed >= timerLimitSeconds) {
    if (!timerElapsedNotified) {
      timerElapsedNotified = true;
      showViewerToast(
        "Timer elapsed",
        "The host session timer has reached its limit.",
        "warn",
      );
    }
  }
}

function startViewerTimer(startTime, limitSeconds = 0) {
  timerStartTime = Number(startTime) || Date.now();
  timerLimitSeconds = Number.isFinite(Number(limitSeconds))
    ? Number(limitSeconds)
    : 0;
  timerElapsedNotified = false;
  $timerOverlay.hidden = false;
  updateTimerDisplay();
  clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
  showViewerToast(
    "Timer started",
    timerLimitSeconds > 0
      ? `${formatDurationLabel(timerLimitSeconds)} session limit is now running.`
      : "The host started an open session timer.",
    "info",
  );
}

function stopViewerTimer() {
  timerStartTime = null;
  timerLimitSeconds = 0;
  timerElapsedNotified = false;
  clearInterval(timerInterval);
  timerInterval = null;
  $timerOverlay.hidden = true;
  setTimerOverlayMode("idle");
}

function resetViewerTimer() {
  timerStartTime = null;
  timerLimitSeconds = 0;
  timerElapsedNotified = false;
  clearInterval(timerInterval);
  timerInterval = null;
  $timerOverlay.hidden = true;
  $timerText.textContent = "00:00:00";
  if ($timerStatus) $timerStatus.textContent = "Idle";
  if ($timerMeta) $timerMeta.textContent = "Waiting for host timer";
  if ($timerProgress) $timerProgress.style.width = "0%";
  setTimerOverlayMode("idle");
}

function setDarkMode(enabled) {
  document.body.classList.toggle("dark-mode", enabled);
  if ($darkModeToggle) {
    $darkModeToggle.textContent = enabled ? "\u2600\uFE0F" : "\uD83C\uDF19";
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

  const activePc = new RTCPeerConnection(rtcConfig);
  pc = activePc;

  activePc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "ice", candidate: e.candidate });
  };

  activePc.ontrack = (e) => {
    if ($video.srcObject !== e.streams[0]) {
      clearStreamRecovery();
      hasLiveStream = true;
      $video.srcObject = e.streams[0];
      syncEmptyState();
      log($log, "Received remote stream.");
      setStatus("connected-live");
      setStreamState("Live stream connected", "Live");
      setHint("Stream received. Use reactions if you need to signal the host.");
      showViewerToast(
        "Stream is live",
        "The host video feed is now playing.",
        "success",
      );
    }
  };

  activePc.onconnectionstatechange = () => {
    if (activePc.connectionState === "connected") {
      clearStreamRecovery();
      setStatus("connected-live");
      setStreamState("Live stream connected", "Live");
    } else if (activePc.connectionState === "disconnected") {
      setStatus("disconnected");
      setStreamState("Stream interrupted", "Interrupted");
      setHint("The stream connection dropped. Trying to recover.");
      if (hasLiveStream) {
        showViewerToast(
          "Stream interrupted",
          "The live feed dropped for a moment.",
          "warn",
        );
      }
      scheduleStreamRecovery({
        delay: 2200,
        title: "Recovering stream",
        message: "The live feed dropped. Rejoining the session now.",
      });
    } else if (activePc.connectionState === "failed") {
      setStatus("failed");
      setStreamState("Stream failed", "Failed");
      setHint("The live stream failed. Trying to reconnect automatically.");
      if (hasLiveStream) {
        showViewerToast(
          "Stream failed",
          "The viewer lost the live media connection.",
          "error",
        );
      }
      scheduleStreamRecovery({
        delay: 700,
        title: "Rejoining stream",
        message: "The live stream failed. Rejoining the host room.",
      });
    } else if (activePc.connectionState === "closed") {
      setStatus("closed");
      setStreamState("Stream closed", "Closed");
      if (hasLiveStream) {
        showViewerToast(
          "Stream stopped",
          "The live media session has ended.",
          "warn",
        );
      }
      scheduleStreamRecovery({
        delay: 1200,
        title: "Recovering stream",
        message: "The media session closed. Rejoining if the host is still live.",
      });
    } else {
      setStatus(activePc.connectionState);
    }
    log($log, "pc state=", activePc.connectionState);
  };

  return activePc;
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
    setStreamState("Room key required", "Locked");
    setConnectButtonLabel("Connect");
    setHint("Enter the room key shared by the host.");
    log($log, "Connection blocked: room key missing.");
    return;
  }

  clearReconnect();
  clearStreamRecovery();
  if (socket) {
    closeSocket({ manual: true });
  }

  manuallyClosed = false;
  joinedViewer = false;
  resetPeer();
  setStatus("connecting");
  setStreamState("Opening signaling link", "Connecting");
  setConnectButtonLabel("Connecting...");
  setHint("Connecting to the signaling server...");
  log($log, "Connecting to signaling server.");

  const activeSocket = new WebSocket(wsUrl());
  socket = activeSocket;

  activeSocket.onopen = () => {
    if (socket !== activeSocket) return;
    setStatus("joining");
    setStreamState("Authenticating room access", "Joining");
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
      clearStreamRecovery();
      joinedViewer = true;
      reconnectAttempt = 0;
      setStatus(msg.waitingForHost ? "waiting-host" : "connected");
      setStreamState(
        msg.waitingForHost ? "Waiting for host stream" : "Connected to room",
        msg.waitingForHost ? "Waiting" : "Connected",
      );
      setConnectButtonLabel("Reconnect");
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
      setStreamState("Access denied", "Denied");
      setConnectButtonLabel("Retry join");
      setHint(describeJoinReason(msg.reason));
      log($log, "Join denied:", describeJoinReason(msg.reason));
      showViewerToast(
        "Join denied",
        describeJoinReason(msg.reason),
        "error",
      );
      closeSocket({ manual: true });
      return;
    }

    if (msg.type === "replaced") {
      joinedViewer = false;
      manuallyClosed = true;
      setStatus("replaced");
      setStreamState("Session replaced", "Replaced");
      setConnectButtonLabel("Reconnect");
      setHint("Another viewer session replaced this tab.");
      log($log, "This viewer session was replaced.");
      showViewerToast(
        "Viewer replaced",
        "Another tab or device took over this viewer session.",
        "warn",
      );
      resetPeer();
      closeSocket({ manual: true });
      return;
    }

    if (msg.type === "host-ready") {
      log($log, "Host ready. Waiting for offer...");
      setStatus("host-ready");
      setStreamState("Host is ready", "Ready");
      setHint("Host is ready. Waiting for the video stream.");
      showViewerToast(
        "Host ready",
        "The stream is preparing to go live.",
        "info",
      );
      return;
    }

    if (msg.type === "host-left") {
      log($log, "Host left.");
      setStatus("host-left");
      setStreamState("Host disconnected", "Offline");
      setConnectButtonLabel("Reconnect");
      setHint("Host disconnected. Waiting for them to reconnect.");
      showViewerToast(
        "Stream stopped",
        "The host went offline or stopped the session.",
        "warn",
      );
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
      setStreamState("Negotiating WebRTC", "Negotiating");
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
      showViewerToast(
        "Timer stopped",
        "The host ended the session timer.",
        "info",
      );
      return;
    }

    if (msg.type === "timer-reset") {
      resetViewerTimer();
      showViewerToast(
        "Timer reset",
        "The session timer was cleared by the host.",
        "info",
      );
    }
  };

  activeSocket.onclose = () => {
    if (socket !== activeSocket && socket !== null) return;
    socket = null;
    resetPeer();
    if (joinedViewer && !manuallyClosed) {
      log($log, "Signaling connection closed unexpectedly.");
      showViewerToast(
        "Signal lost",
        "Reconnecting to the host session.",
        "warn",
      );
      scheduleReconnect();
      return;
    }
    if (!manuallyClosed) {
      setStatus("ws-closed");
      setStreamState("Socket closed", "Offline");
      setConnectButtonLabel("Reconnect");
      setHint("Socket closed. Press Connect to try again.");
      showViewerToast(
        "Session offline",
        "The signaling connection closed.",
        "warn",
      );
    }
  };

  activeSocket.onerror = () => {
    if (socket !== activeSocket) return;
    log($log, "WebSocket error.");
    setStreamState("Socket error", "Warning");
    setHint("Socket error. Waiting for the connection state to settle.");
    showViewerToast(
      "Connection warning",
      "The signaling channel reported an error.",
      "error",
    );
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

if ($fullscreenToggle) {
  $fullscreenToggle.addEventListener("click", () => {
    toggleViewerFullscreen();
  });
}

document.addEventListener("fullscreenchange", syncFullscreenButton);

window.addEventListener("beforeunload", () => {
  closeSocket({ manual: true });
  clearInterval(timerInterval);
  clearStreamRecovery();
});

syncFullscreenButton();

if (initialRoomKey) {
  connectSocket();
} else {
  setStreamState("Awaiting secure room key", "Standby");
  setConnectButtonLabel("Connect");
  syncEmptyState();
}
