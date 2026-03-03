require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fetch = require("node-fetch");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));

const rooms = {};
const COLORS  = ["#ff6b6b","#4d96ff","#ffd93d","#6bcb77","#a78bfa","#ff6fc8"];
const TOPICS  = ["חתול","בית","עץ","מכונית","שמש","דג","ציפור","פרח","כוכב","רובוט","עוגה","רקטה","בלון","ים","הר","פרפר","ספינה","מטוס","דינוזאור","גשר","כלב","סוס","צב","פיל","תנין","כריש","פינגווין","ארנב","פרה"];
const DRAW_TIME  = 60;
const MAX_ROUNDS = 5;

function getLobbyList() {
  return Object.values(rooms)
    .filter(r => r.phase === "lobby")
    .map(r => ({ id:r.id, host:r.players[0]&&r.players[0].name||"?", count:r.players.length, max:r.maxPlayers }));
}

function pushLobby() { io.emit("lobby_list", getLobbyList()); }

function broadcast(r) {
  io.to(r.id).emit("state", {
    id:r.id, hostId:r.hostId, maxPlayers:r.maxPlayers,
    players:r.players, phase:r.phase, round:r.round, topic:r.topic,
    submitted:Object.keys(r.drawings), lastWinner:r.lastWinner
  });
}

function startRound(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  r.round++;
  r.phase = "drawing";
  r.drawings = {};
  r.lastWinner = null;
  r.topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  r.timeLeft = DRAW_TIME;
  broadcast(r);
  pushLobby();

  r.timer = setInterval(function() {
    r.timeLeft--;
    io.to(r.id).emit("tick", r.timeLeft);
    if (r.timeLeft <= 0) { clearInterval(r.timer); r.timer = null; judge(roomId); }
  }, 1000);
}

async function judge(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  r.phase = "judging";
  broadcast(r);

  const drawers = r.players.filter(function(p) { return r.drawings[p.id]; });
  if (!drawers.length) {
    r.phase = "results";
    r.lastWinner = { name:"אף אחד", color:"#aaa", reason:"אף אחד לא צייר!" };
    broadcast(r);
    io.to(r.id).emit("drawings", r.drawings);
    return;
  }

  try {
    const parts = drawers.map(function(p) {
      return { inlineData: { mimeType:"image/png", data:r.drawings[p.id].split(",")[1] } };
    });
    const names = drawers.map(function(p,i) { return "ציור "+(i+1)+": "+p.name; }).join("\n");
    parts.push({ text:"שופט תחרות ציורים. נושא: \""+r.topic+"\".\n"+names+"\nבחר מנצח לפי קרבה לנושא ויצירתיות.\nענה JSON בלבד: {\"winner\":\"שם\",\"reason\":\"סיבה בעברית\"}" });

    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key="+process.env.GEMINI_API_KEY,
      { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ contents:[{ parts:parts }] }) }
    );
    const data = await res.json();
    console.log("Gemini:", JSON.stringify(data).slice(0,300));
    const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON: "+text.slice(0,80));
    const parsed = JSON.parse(m[0]);
    const winner = drawers.find(function(p){ return p.name===parsed.winner; })
      || drawers.find(function(p){ return parsed.winner && parsed.winner.includes(p.name); })
      || drawers[0];
    winner.score = (winner.score||0) + 1;
    r.lastWinner = { id:winner.id, name:winner.name, color:winner.color, reason:parsed.reason };
  } catch(e) {
    console.error("judge error:", e.message);
    const w = drawers[Math.floor(Math.random()*drawers.length)];
    w.score = (w.score||0) + 1;
    r.lastWinner = { id:w.id, name:w.name, color:w.color, reason:"השופט בחר באקראי" };
  }

  r.phase = "results";
  broadcast(r);
  io.to(r.id).emit("drawings", r.drawings);
}

io.on("connection", function(socket) {
  console.log("+ connect", socket.id);
  socket.emit("lobby_list", getLobbyList());

  socket.on("create", function(data) {
    const name = data.name || "מארח";
    const maxPlayers = Math.min(Math.max(+(data.maxPlayers)||2, 2), 3);
    const id = Math.random().toString(36).slice(2,8).toUpperCase();
    rooms[id] = {
      id:id, hostId:socket.id, maxPlayers:maxPlayers,
      players:[{ id:socket.id, name:name, color:COLORS[0], score:0 }],
      phase:"lobby", round:0, topic:"", drawings:{}, timer:null, timeLeft:0, lastWinner:null
    };
    socket.join(id);
    socket.data.roomId = id;
    socket.emit("joined", id);
    broadcast(rooms[id]);
    pushLobby();
  });

  socket.on("join", function(data) {
    const r = rooms[data.roomId];
    if (!r) return socket.emit("err", "חדר לא נמצא");
    if (r.phase !== "lobby") return socket.emit("err", "המשחק כבר התחיל");
    if (r.players.length >= r.maxPlayers) return socket.emit("err", "החדר מלא");
    const name = data.name || "שחקן";
    r.players.push({ id:socket.id, name:name, color:COLORS[r.players.length % COLORS.length], score:0 });
    socket.join(data.roomId);
    socket.data.roomId = data.roomId;
    socket.emit("joined", data.roomId);
    broadcast(r);
    pushLobby();
  });

  socket.on("start", function() {
    const r = rooms[socket.data.roomId];
    if (!r || r.hostId !== socket.id) return;
    if (r.players.length < 2) return socket.emit("err", "צריך לפחות 2 שחקנים");
    startRound(r.id);
  });

  socket.on("draw", function(data) {
    const r = rooms[socket.data.roomId];
    if (!r || r.phase !== "drawing") return;
    r.drawings[socket.id] = data.drawing;
    broadcast(r);
    const allDone = r.players.every(function(p){ return r.drawings[p.id]; });
    if (allDone) { clearInterval(r.timer); r.timer = null; judge(r.id); }
  });

  socket.on("next", function() {
    const r = rooms[socket.data.roomId];
    if (!r || r.hostId !== socket.id) return;
    if (r.round >= MAX_ROUNDS) { r.phase = "done"; broadcast(r); }
    else startRound(r.id);
  });

  socket.on("disconnect", function() {
    const r = rooms[socket.data && socket.data.roomId];
    if (!r) return;
    r.players = r.players.filter(function(p){ return p.id !== socket.id; });
    if (r.players.length === 0) { clearInterval(r.timer); delete rooms[r.id]; }
    else { if (r.hostId === socket.id) r.hostId = r.players[0].id; broadcast(r); }
    pushLobby();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, function() { console.log("Server on port " + PORT); });
