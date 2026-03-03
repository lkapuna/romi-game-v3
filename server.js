require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json({ limit: "30mb" }));

// ── Data ──────────────────────────────────────────────────────────────
const rooms = {};
const COLORS = ["#ff6b6b","#4d96ff","#ffd93d","#6bcb77","#a78bfa","#ff6fc8"];
const TOPICS = ["חתול","בית","עץ","מכונית","שמש","דג","ציפור","פרח","כוכב","רובוט","עוגה","רקטה","בלון","ים","הר","פרפר","ספינה","מטוס","דינוזאור","גשר","כלב","סוס","צב","פיל","ג'ירפה","תנין","כריש","פינגווין","ארנב","פרה"];
const DRAW_TIME = 60;
const MAX_ROUNDS = 5;

function randomCode() {
  return Math.random().toString(36).substring(2,7).toUpperCase();
}

function broadcast(code) {
  const r = rooms[code];
  if (!r) return;
  io.to(code).emit("state", {
    code: r.code,
    hostId: r.hostId,
    maxPlayers: r.maxPlayers,
    players: r.players,
    phase: r.phase,
    round: r.round,
    topic: r.topic,
    submitted: Object.keys(r.drawings),
    lastWinner: r.lastWinner,
  });
}

function startRound(code) {
  const r = rooms[code];
  if (!r) return;
  r.round++;
  r.phase = "drawing";
  r.drawings = {};
  r.lastWinner = null;
  r.topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  r.timeLeft = DRAW_TIME;
  broadcast(code);

  r.timer = setInterval(() => {
    r.timeLeft--;
    io.to(code).emit("tick", r.timeLeft);
    if (r.timeLeft <= 0) {
      clearInterval(r.timer);
      r.timer = null;
      judge(code);
    }
  }, 1000);
}

async function judge(code) {
  const r = rooms[code];
  if (!r) return;
  r.phase = "judging";
  broadcast(code);

  const drawers = r.players.filter(p => r.drawings[p.id]);
  if (drawers.length === 0) {
    r.phase = "results";
    r.lastWinner = { name: "אף אחד", color: "#aaa", reason: "אף אחד לא צייר!" };
    broadcast(code);
    io.to(code).emit("drawings", r.drawings);
    return;
  }

  try {
    const parts = [];
    for (const p of drawers) {
      parts.push({ inlineData: { mimeType: "image/png", data: r.drawings[p.id].split(",")[1] } });
    }
    const names = drawers.map((p,i) => `ציור ${i+1}: ${p.name}`).join("\n");
    parts.push({ text: `שופט תחרות ציורים. נושא: "${r.topic}".\n${names}\nבחר מנצח לפי קרבה לנושא ויצירתיות.\nענה JSON בלבד: {"winner":"שם","reason":"סיבה בעברית"}` });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ contents:[{ parts }] }) }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m[0]);
    const winner = drawers.find(p => p.name === parsed.winner) || drawers.find(p => parsed.winner?.includes(p.name)) || drawers[0];
    winner.score = (winner.score||0) + 1;
    r.lastWinner = { id: winner.id, name: winner.name, color: winner.color, reason: parsed.reason };
  } catch(e) {
    console.error("judge error:", e.message);
    const w = drawers[Math.floor(Math.random()*drawers.length)];
    w.score = (w.score||0) + 1;
    r.lastWinner = { id: w.id, name: w.name, color: w.color, reason: "השופט בחר באקראי" };
  }

  r.phase = "results";
  broadcast(code);
  io.to(code).emit("drawings", r.drawings);
}

// ── Sockets ──────────────────────────────────────────────────────────
io.on("connection", socket => {
  console.log("connect:", socket.id);

  socket.on("create", ({ name, maxPlayers }) => {
    const code = randomCode();
    rooms[code] = {
      code, hostId: socket.id,
      maxPlayers: Math.min(Math.max(+maxPlayers||2, 2), 4),
      players: [{ id: socket.id, name: name||"מארח", color: COLORS[0], score: 0 }],
      phase: "lobby", round: 0, topic: "", drawings: {}, timer: null, timeLeft: 0, lastWinner: null
    };
    socket.join(code);
    socket.data.code = code;
    socket.emit("created", code);
    broadcast(code);
  });

  socket.on("join", ({ code, name }) => {
    const r = rooms[code];
    if (!r) return socket.emit("err", "חדר לא נמצא");
    if (r.phase !== "lobby") return socket.emit("err", "המשחק כבר התחיל");
    if (r.players.length >= r.maxPlayers) return socket.emit("err", "החדר מלא");
    r.players.push({ id: socket.id, name: name||"שחקן", color: COLORS[r.players.length % COLORS.length], score: 0 });
    socket.join(code);
    socket.data.code = code;
    broadcast(code);
  });

  socket.on("start", () => {
    const r = rooms[socket.data.code];
    if (!r || r.hostId !== socket.id) return;
    if (r.players.length < r.maxPlayers) return socket.emit("err", `ממתין לעוד שחקנים (${r.players.length}/${r.maxPlayers})`);
    startRound(socket.data.code);
  });

  socket.on("draw", ({ drawing }) => {
    const r = rooms[socket.data.code];
    if (!r || r.phase !== "drawing") return;
    r.drawings[socket.id] = drawing;
    broadcast(socket.data.code);
    if (r.players.every(p => r.drawings[p.id])) {
      clearInterval(r.timer); r.timer = null;
      judge(socket.data.code);
    }
  });

  socket.on("next", () => {
    const r = rooms[socket.data.code];
    if (!r || r.hostId !== socket.id) return;
    if (r.round >= MAX_ROUNDS) { r.phase = "done"; broadcast(socket.data.code); }
    else startRound(socket.data.code);
  });

  socket.on("disconnect", () => {
    const code = socket.data?.code;
    const r = rooms[code];
    if (!r) return;
    r.players = r.players.filter(p => p.id !== socket.id);
    if (r.players.length === 0) { clearInterval(r.timer); delete rooms[code]; return; }
    if (r.hostId === socket.id) r.hostId = r.players[0].id;
    broadcast(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("✅ http://localhost:" + PORT));
