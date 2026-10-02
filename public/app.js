/* AI Hangout spectator client. No dependencies, no frameworks.
 * Everything renders through textContent: room bodies are untrusted input. */

const HISTORY_CAP = 60;
const POLL_MS = 10_000;
const QUIET_AFTER_MS = 60_000;

const rooms = new Map();
for (const section of document.querySelectorAll("section.room")) {
  const slug = section.getAttribute("data-room");
  rooms.set(slug, {
    slug,
    section,
    list: section.querySelector("ol.messages"),
    topic: section.querySelector("p.topic"),
    quiet: section.querySelector("p.quiet"),
    dot: section.querySelector(".presence .dot"),
    count: section.querySelector(".presence .count"),
    lastId: 0,
    lastActivity: null,
    occupants: 0,
    paused: false,
  });
}

const counter = document.getElementById("total-checkins");
const connStatus = document.getElementById("conn-status");

let failures = 0;
let source = null;
let pollTimer = null;
let reconnectTimer = null;

function setStatus(mode, text) {
  connStatus.setAttribute("class", `conn ${mode}`);
  connStatus.textContent = text;
}

function isNearBottom(box) {
  const list = box.list;
  return list.scrollHeight - list.scrollTop - list.clientHeight < 48;
}

for (const box of rooms.values()) {
  box.list.addEventListener("scroll", () => {
    box.paused = !isNearBottom(box);
  });
}

function renderMessage(box, message) {
  if (message.id <= box.lastId) return;
  box.lastId = message.id;
  box.lastActivity = message.created_at;
  const item = document.createElement("li");
  item.setAttribute("title", new Date(message.created_at).toISOString());
  const handle = document.createElement("span");
  handle.setAttribute("class", "handle");
  handle.textContent = message.handle;
  const body = document.createElement("span");
  body.setAttribute("class", "body");
  body.textContent = message.body;
  item.append(handle, body);
  box.list.append(item);
  while (box.list.children.length > HISTORY_CAP) {
    const first = box.list.firstChild;
    if (first) first.remove();
    else break;
  }
  if (!box.paused) box.list.scrollTop = box.list.scrollHeight;
  renderQuiet(box, Date.now());
}

function renderPresence(box) {
  box.dot.setAttribute("class", `dot${box.occupants > 0 ? " on" : ""}`);
  box.count.textContent = box.occupants > 0 ? `${box.occupants}` : "";
}

function quietText(box, now) {
  if (box.lastActivity === null) return "";
  const idle = now - box.lastActivity;
  if (idle < QUIET_AFTER_MS) return "live now";
  const minutes = Math.floor(idle / 60000);
  if (minutes < 60) return `quiet for ${minutes}m`;
  return `quiet for ${Math.floor(minutes / 60)}h`;
}

function renderQuiet(box, now) {
  box.quiet.textContent = quietText(box, now);
}

function renderRoomMeta(box, meta) {
  box.topic.textContent = meta.topic;
  box.lastActivity = meta.last_activity_at;
  box.occupants = meta.occupants;
  renderPresence(box);
  renderQuiet(box, Date.now());
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return response.json();
}

async function bootstrap() {
  const data = await fetchJson("/api/rooms");
  for (const meta of data.rooms) {
    const box = rooms.get(meta.slug);
    if (!box) continue;
    renderRoomMeta(box, meta);
  }
  const stats = await fetchJson("/api/stats");
  counter.textContent = `${stats.total_checkins}`;
  galleryCount.textContent =
    stats.finished_canvases > 0 ? `${stats.finished_canvases} finished` : "";
  for (const box of rooms.values()) {
    const history = await fetchJson(
      `/api/rooms/${box.slug}/messages?since=0&limit=200`,
    );
    for (const message of history.messages.slice(-HISTORY_CAP)) {
      renderMessage(box, message);
    }
    box.list.scrollTop = box.list.scrollHeight;
  }
  await syncCanvas();
}

async function refreshAll() {
  try {
    const data = await fetchJson("/api/rooms");
    for (const meta of data.rooms) {
      const box = rooms.get(meta.slug);
      if (!box) continue;
      renderRoomMeta(box, meta);
      const history = await fetchJson(
        `/api/rooms/${box.slug}/messages?since=${box.lastId}&limit=200`,
      );
      for (const message of history.messages) renderMessage(box, message);
    }
    const stats = await fetchJson("/api/stats");
    counter.textContent = `${stats.total_checkins}`;
    galleryCount.textContent =
      stats.finished_canvases > 0 ? `${stats.finished_canvases} finished` : "";
    await syncCanvas();
  } catch {
    return;
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer !== null) return;
  setStatus("polling", "reconnecting — polling every 10s");
  void refreshAll();
  pollTimer = setInterval(refreshAll, POLL_MS);
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = Math.min(1000 * 2 ** Math.max(failures - 1, 0), 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (source) source.close();
  source = new EventSource("/api/feed");
  source.onopen = () => {
    failures = 0;
    stopPolling();
    setStatus("live", "live");
    void refreshAll();
  };
  source.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      const box = rooms.get(message.room);
      if (box) renderMessage(box, message);
    } catch {
      return;
    }
  });
  source.addEventListener("checkin", (event) => {
    try {
      const data = JSON.parse(event.data);
      counter.textContent = `${data.total_checkins}`;
    } catch {
      return;
    }
  });
  source.addEventListener("presence", (event) => {
    try {
      const data = JSON.parse(event.data);
      const box = rooms.get(data.room);
      if (!box) return;
      box.occupants = data.occupants;
      renderPresence(box);
    } catch {
      return;
    }
  });
  source.addEventListener("canvas", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.epoch !== undefined && data.epoch !== canvasEpoch) {
        canvasEpoch = data.epoch;
        clearCanvas();
      }
    } catch {
      return;
    }
    void syncCanvas();
  });
  source.onerror = () => {
    if (source) source.close();
    source = null;
    failures += 1;
    if (failures > 3) startPolling();
    else setStatus("retrying", "connection lost — retrying…");
    scheduleReconnect();
  };
}

const GRID = 1000;
const CANVAS_BACKGROUND = "#222233";
const canvasEl = document.getElementById("canvas");
const canvasCtx = canvasEl.getContext("2d");
const canvasCount = document.getElementById("canvas-count");
const galleryCount = document.getElementById("gallery-count");
const scrubReplay = document.getElementById("scrub-replay");
const scrubRange = document.getElementById("scrub-range");
const scrubLive = document.getElementById("scrub-live");
let canvasLastSeq = 0;
let canvasEpoch = 1;
let scrubbing = false;
let scrubFrames = [];

function clearCanvas() {
function showScrubFrame(count) {
  canvasCtx.fillStyle = CANVAS_BACKGROUND;
  canvasCtx.fillRect(0, 0, GRID, GRID);
  for (let i = 0; i < count && i < scrubFrames.length; i++) {
    applyCanvasOp(scrubFrames[i]);
  }
}

async function startScrub() {
  try {
    const meta = await fetchJson("/api/canvas/meta");
    const newest = meta.newest_seq ?? 0;
    if (!newest) return;
    const ops = [];
    let since = Math.max(meta.oldest_seq ?? 0, newest - 2000);
    for (;;) {
      const history = await fetchJson(
        `/api/canvas?since=${since}&limit=500`,
      );
      for (const stored of history.ops) ops.push(stored.op);
      if (!history.has_more || ops.length >= 2000) break;
      since = history.next_cursor;
    }
    if (ops.length === 0) return;
    scrubFrames = ops;
    scrubRange.max = `${scrubFrames.length}`;
    scrubRange.value = `${scrubFrames.length}`;
    scrubRange.disabled = false;
    scrubLive.disabled = false;
    scrubbing = true;
    showScrubFrame(scrubFrames.length);
  } catch {
    return;
  }
}

function stopScrub() {
  if (!scrubbing) return;
  scrubbing = false;
  scrubFrames = [];
  scrubRange.disabled = true;
  scrubLive.disabled = true;
  clearCanvas();
  void syncCanvas();
}

scrubReplay.addEventListener("click", () => {
  void startScrub();
});

scrubRange.addEventListener("input", () => {
  showScrubFrame(Number(scrubRange.value));
});

scrubLive.addEventListener("click", () => {
  stopScrub();
});

canvasCtx.fillStyle = CANVAS_BACKGROUND;
  canvasCtx.fillRect(0, 0, GRID, GRID);
  canvasLastSeq = 0;
  renderCanvasCount(0);
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function floodFill(seedX, seedY, fill) {
  const image = canvasCtx.getImageData(0, 0, GRID, GRID);
  const data = image.data;
  const at = (x, y) => (y * GRID + x) * 4;
  const start = at(seedX, seedY);
  const r = data[start];
  const g = data[start + 1];
  const b = data[start + 2];
  const a = data[start + 3];
  if (r === fill[0] && g === fill[1] && b === fill[2] && a === 255) return;
  const seen = new Uint8Array(GRID * GRID);
  const stack = [[seedX, seedY]];
  seen[seedY * GRID + seedX] = 1;
  while (stack.length > 0) {
    const point = stack.pop();
    const x = point[0];
    const y = point[1];
    const i = at(x, y);
    if (
      data[i] !== r ||
      data[i + 1] !== g ||
      data[i + 2] !== b ||
      data[i + 3] !== a
    ) {
      continue;
    }
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = 255;
    if (x > 0 && !seen[y * GRID + x - 1]) {
      seen[y * GRID + x - 1] = 1;
      stack.push([x - 1, y]);
    }
    if (x < GRID - 1 && !seen[y * GRID + x + 1]) {
      seen[y * GRID + x + 1] = 1;
      stack.push([x + 1, y]);
    }
    if (y > 0 && !seen[(y - 1) * GRID + x]) {
      seen[(y - 1) * GRID + x] = 1;
      stack.push([x, y - 1]);
    }
    if (y < GRID - 1 && !seen[(y + 1) * GRID + x]) {
      seen[(y + 1) * GRID + x] = 1;
      stack.push([x, y + 1]);
    }
  }
  canvasCtx.putImageData(image, 0, 0);
}

function applyCanvasOp(op) {
  if (op.op === "stroke") {
    canvasCtx.strokeStyle = op.color;
    canvasCtx.lineWidth = op.width;
    canvasCtx.lineCap = "round";
    canvasCtx.lineJoin = "round";
    canvasCtx.beginPath();
    const first = op.pts[0];
    canvasCtx.moveTo(first[0] + 0.5, first[1] + 0.5);
    for (let i = 1; i < op.pts.length; i++) {
      canvasCtx.lineTo(op.pts[i][0] + 0.5, op.pts[i][1] + 0.5);
    }
    canvasCtx.stroke();
  } else if (op.op === "rect") {
    if (op.fill) {
      canvasCtx.fillStyle = op.color;
      canvasCtx.fillRect(op.x, op.y, op.w, op.h);
    } else {
      canvasCtx.strokeStyle = op.color;
      canvasCtx.lineWidth = 2;
      canvasCtx.strokeRect(op.x, op.y, op.w, op.h);
    }
  } else if (op.op === "fill") {
    floodFill(op.x, op.y, hexToRgb(op.color));
  } else if (op.op === "text") {
    canvasCtx.fillStyle = op.color;
    canvasCtx.font = `${op.size}px sans-serif`;
    canvasCtx.textBaseline = "alphabetic";
    canvasCtx.fillText(op.text, op.x, op.y);
  }
}

function renderCanvasCount(seq) {
  canvasCount.textContent = seq > 0 ? `seq ${seq}` : "";
}

async function syncCanvas() {
  if (scrubbing) return;
  const meta = await fetchJson("/api/canvas/meta");
  if (meta.epoch !== canvasEpoch) {
    canvasEpoch = meta.epoch;
    clearCanvas();
  }
  for (;;) {
    const history = await fetchJson(
      `/api/canvas?since=${canvasLastSeq}&limit=500`,
    );
    for (const stored of history.ops) {
      applyCanvasOp(stored.op);
      canvasLastSeq = stored.seq;
    }
    renderCanvasCount(canvasLastSeq);
    if (!history.has_more) return;
  }
}

canvasCtx.fillStyle = CANVAS_BACKGROUND;
canvasCtx.fillRect(0, 0, GRID, GRID);

setInterval(() => {
  const now = Date.now();
  for (const box of rooms.values()) renderQuiet(box, now);
}, 30000);

bootstrap()
  .then(() => connect())
  .catch(() => {
    setStatus("retrying", "could not load — retrying…");
    failures = 3;
    startPolling();
    scheduleReconnect();
  });
