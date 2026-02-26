import { qs, randomId, wsUrl, log } from "./common.js";

const roomId = qs("room") || "demo";
const viewerId = qs("id") || randomId();

const $room = document.getElementById("room");
const $status = document.getElementById("status");
const $video = document.getElementById("video");
const $log = document.getElementById("log");

$room.textContent = roomId;

let pc = null;
const socket = new WebSocket(wsUrl());

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function setStatus(s) {
  $status.textContent = s;
}
function send(msg) {
  socket.send(JSON.stringify({ ...msg, roomId, viewerId }));
}
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
};
