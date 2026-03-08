require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fetch = require("node-fetch");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static("public"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ── MongoDB ───────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI).then(function() {
  console.log("MongoDB connected");
}).catch(function(e) {
  console.error("MongoDB error:", e.message);
});

const UserSchema = new mongoose.Schema({
  phone: { type: String, unique: true, sparse: true },
  username: { type: String, unique: true, trim: true },
  pin: String,
  wins: { type: Number, default: 0 },
  gamesPlayed: { type: Number, default: 0 },
  streak: { type: Number, default: 0 },
  maxStreak: { type: Number, default: 0 },
  badges: { type: [String], default: [] },
  securityQuestion: { type: String, default: "" },
  securityAnswer: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  coins: { type: Number, default: 0 }
});

const User = mongoose.model("User", UserSchema);

// ── Auth API ──────────────────────────────────────────────────────────
app.post("/auth/register", async function(req, res) {
  try {
    var username = (req.body.username || "").trim();
    var pin = (req.body.pin || "").trim();
    var phone = (req.body.phone || "").replace(/[^0-9]/g, "");
    if (!username || username.length < 2) return res.json({ ok: false, error: "שם חייב להיות לפחות 2 תווים" });
    if (!/^\d{4}$/.test(pin)) return res.json({ ok: false, error: "הקוד חייב להיות 4 ספרות" });
    if (!phone || phone.length < 9) return res.json({ ok: false, error: "מספר טלפון לא תקין" });

    var exists = await User.findOne({ username: { $regex: new RegExp("^"+username+"$", "i") } });
    if (exists) return res.json({ ok: false, error: "שם זה כבר תפוס, בחר שם אחר" });

    var phoneExists = await User.findOne({ phone: phone });
    if (phoneExists) return res.json({ ok: false, error: "מספר טלפון זה כבר רשום" });

    var answer = (req.body.answer || "").trim().toLowerCase();
    var question = (req.body.question || "").trim();
    if (!question || !answer) return res.json({ ok: false, error: "חסרה שאלת אבטחה" });
    var hashed = await bcrypt.hash(pin, 10);
    var answerHashed = await bcrypt.hash(answer, 10);
    var user = await User.create({ username: username, pin: hashed, phone: phone, securityQuestion: question, securityAnswer: answerHashed });
    res.json({ ok: true, user: { id: user._id, username: user.username, wins: 0, gamesPlayed: 0, coins: 0 } });
  } catch(e) {
    res.json({ ok: false, error: "שגיאה, נסה שוב" });
  }
});

app.post("/auth/login", async function(req, res) {
  try {
    var username = (req.body.username || "").trim();
    var pin = (req.body.pin || "").trim();
    var user = await User.findOne({ username: { $regex: new RegExp("^"+username+"$", "i") } });
    if (!user) return res.json({ ok: false, error: "שם משתמש לא נמצא" });
    var match = await bcrypt.compare(pin, user.pin);
    if (!match) return res.json({ ok: false, error: "קוד שגוי" });
    res.json({ ok: true, user: { id: user._id, username: user.username, wins: user.wins, gamesPlayed: user.gamesPlayed, coins: user.coins||0 } });
  } catch(e) {
    res.json({ ok: false, error: "שגיאה, נסה שוב" });
  }
});

// Leaderboard
app.get("/leaderboard", async function(req, res) {
  try {
    var top = await User.find({}, "username wins gamesPlayed badges").sort({ wins: -1 }).limit(20);
    res.json(top);
  } catch(e) { res.json([]); }
});

app.post("/auth/find-by-phone", async function(req, res) {
  try {
    var phone = (req.body.phone || "").replace(/[^0-9]/g, "");
    var user = await User.findOne({ phone: phone });
    if (!user) return res.json({ ok: false, error: "לא נמצא חשבון עם מספר זה" });
    res.json({ ok: true, userId: user._id, username: user.username, question: user.securityQuestion });
  } catch(e) {
    res.json({ ok: false, error: "שגיאה, נסה שוב" });
  }
});

app.post("/auth/verify-answer", async function(req, res) {
  try {
    var user = await User.findById(req.body.userId);
    if (!user) return res.json({ ok: false, error: "משתמש לא נמצא" });
    var answer = (req.body.answer || "").trim().toLowerCase();
    var match = await bcrypt.compare(answer, user.securityAnswer);
    if (!match) return res.json({ ok: false, error: "תשובה שגויה" });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: "שגיאה" });
  }
});

app.post("/auth/reset-pin", async function(req, res) {
  try {
    var userId = req.body.userId;
    var pin = (req.body.pin || "").trim();
    if (!/^\d{4}$/.test(pin)) return res.json({ ok: false, error: "קוד לא תקין" });
    var hashed = await bcrypt.hash(pin, 10);
    await User.findByIdAndUpdate(userId, { pin: hashed });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: "שגיאה, נסה שוב" });
  }
});

app.get("/auth/check/:username", async function(req, res) {
  try {
    var user = await User.findOne({ username: { $regex: new RegExp("^"+req.params.username+"$", "i") } });
    res.json({ exists: !!user });
  } catch(e) {
    res.json({ exists: false });
  }
});

// ── Badge Logic ──────────────────────────────────────────────────────
var BADGES = [
  { id:"first_win", label:"🥇 ניצחון ראשון", check: function(u){ return u.wins >= 1; } },
  { id:"10_wins", label:"🏆 מלך הציור", check: function(u){ return u.wins >= 10; } },
  { id:"50_wins", label:"🌟 אגדת הציור", check: function(u){ return u.wins >= 50; } },
  { id:"streak3", label:"🔥 3 ברצף", check: function(u){ return u.maxStreak >= 3; } },
  { id:"streak5", label:"⚡ 5 ברצף", check: function(u){ return u.maxStreak >= 5; } },
  { id:"10_games", label:"🎮 שחקן מנוסה", check: function(u){ return u.gamesPlayed >= 10; } },
  { id:"50_games", label:"🎨 אמן אמיתי", check: function(u){ return u.gamesPlayed >= 50; } },
];

async function checkAndAwardBadges(userId) {
  try {
    var user = await User.findById(userId);
    if (!user) return [];
    var newBadges = [];
    BADGES.forEach(function(b) {
      if (!user.badges.includes(b.id) && b.check(user)) {
        user.badges.push(b.id);
        newBadges.push(b);
      }
    });
    if (newBadges.length > 0) await user.save();
    return newBadges;
  } catch(e) { return []; }
}

// ── Solo Judge ───────────────────────────────────────────────────────
app.post("/solo/judge", async function(req, res) {
  try {
    var topic = req.body.topic;
    var drawing = req.body.drawing;

    var response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.GROQ_API_KEY},
        body:JSON.stringify({
          model:"meta-llama/llama-4-scout-17b-16e-instruct",
          max_tokens:400,
          messages:[{
            role:"user",
            content:[
              { type:"image_url", image_url:{ url: drawing } },
              { type:"text", text:"אתה שופט ציורים לילדים. הנושא היה: "+topic+". אם הציור ריק לחלוטין או לא מציג שום תוכן, תן ציון 0 ואמור שהקנבס ריק. אחרת תן ציון 1-10 ומשוב מעודד. ענה JSON בלבד: {\"score\":מספר,\"feedback\":\"משוב\",\"tip\":\"טיפ\",\"badge\":null_או_תג}" }


            ]
          }]
        })
      }
    );
    var data = await response.json();
    var text = (data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content) || "";
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON");
    var parsed = JSON.parse(m[0]);
    res.json({ score: parsed.score||5, feedback: parsed.feedback||"ציור יפה!", tip: parsed.tip||"", badge: parsed.badge||null });
  } catch(e) {
    console.error("solo judge error:", e.message);
    res.json({ score: 5, feedback: "ציור יפה! המשך לצייר!", tip: "נסה להוסיף פרטים", badge: null });
  }
});

// ── Game State ────────────────────────────────────────────────────────
const rooms = {};
const COLORS = ["#ff6b6b","#4d96ff","#ffd93d","#6bcb77","#a78bfa","#ff6fc8"];
const TOPICS = ["חתול","כלב","סוס","פיל","תנין","כריש","פינגווין","ארנב","פרה","אריה","צב","דג","ציפור","פרפר","תוכי","קוף","זאב","דב","נחש","תמנון","ינשוף","עוגה","פיצה","גלידה","המבורגר","תות","אבטיח","עוגיה","ענבים","תפוח","גזר","עץ","פרח","שמש","ים","הר","ענן","קשת בענן","וולקן","יער","ירח","כוכב","חורף","קיץ","מכונית","רקטה","ספינה","מטוס","אופניים","צוללת","רכבת","מסוק","חללית","בית","בלון","גשר","רובוט","כיסא","מנורה","טלפון","מחשב","מטרייה","כובע","נעל","תיק","שעון","דינוזאור","פיראט","פיראטים","קוסם","נסיכה","דרדסים","דרקון","חייזר","כדורגל","כדורסל","גיטרה","תוף","שחמט","גלישה","מערה","זיקוקים","בלונים"];
const DRAW_TIME = 60;
const MAX_ROUNDS = 5;

function getLobbyList() {
  return Object.values(rooms)
    .filter(function(r) { return r.phase !== "done" && r.phase !== "abandoned"; })
    .map(function(r) {
      var canJoin = r.phase !== "done" && r.phase !== "abandoned" && r.players.length < r.maxPlayers;
      return { id:r.id, host:r.players[0]&&r.players[0].name||"?", count:r.players.length, max:r.maxPlayers, phase:r.phase, canJoin:canJoin };
    });
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
  var r = rooms[roomId];
  if (!r) return;
  r.round++;
  r.phase = "drawing";
  r.drawings = {};
  r.lastWinner = null;
  var available = TOPICS.filter(function(t){ return !r.usedTopics.includes(t); });
  if(available.length === 0) { r.usedTopics = []; available = TOPICS; }
  r.topic = available[Math.floor(Math.random() * available.length)];
  r.usedTopics.push(r.topic);
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
  var r = rooms[roomId];
  if (!r) return;
  r.phase = "judging";
  broadcast(r);

  var drawers = r.players.filter(function(p) { return r.drawings[p.id]; });
  if (!drawers.length) {
    r.phase = "results";
    r.lastWinner = { name:"אף אחד", color:"#aaa", reason:"אף אחד לא צייר!" };
    io.to(r.id).emit("drawings", r.drawings);
    broadcast(r);
    return;
  }

  try {
    var imageMessages = drawers.map(function(p) {
      return { type:"image_url", image_url:{ url: r.drawings[p.id] } };
    });
    var names = drawers.map(function(p,i) { return "ציור "+(i+1)+": "+p.name; }).join("\n");

    var res = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.GROQ_API_KEY},
        body:JSON.stringify({
          model:"meta-llama/llama-4-scout-17b-16e-instruct",
          max_tokens:300,
          messages:[{
            role:"user",
            content:[
              ...imageMessages,
              { type:"text", text:"שופט תחרות ציורים. נושא: \""+r.topic+"\".\n"+names+"\nבחר מנצח לפי קרבה לנושא ויצירתיות.\nענה JSON בלבד: {\"winner\":\"שם\",\"reason\":\"סיבה בעברית\"}" }
            ]
          }]
        })
      }
    );
    var data = await res.json();
    var text = (data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content) || "";
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON");
    var parsed = JSON.parse(m[0]);
    var winner = drawers.find(function(p){ return p.name===parsed.winner; })
      || drawers.find(function(p){ return parsed.winner&&parsed.winner.includes(p.name); })
      || drawers[0];
    winner.score = (winner.score||0) + 1;
    r.lastWinner = { id:winner.id, name:winner.name, color:winner.color, reason:parsed.reason };

    // Update stats + streak + badges
    if (winner.userId) {
      var updatedUser = await User.findByIdAndUpdate(
        winner.userId,
        { $inc: { wins: 1, streak: 1, coins: 1 } },
        { new: true }
      );
      if (updatedUser && updatedUser.streak > updatedUser.maxStreak) {
        await User.findByIdAndUpdate(winner.userId, { maxStreak: updatedUser.streak });
        updatedUser.maxStreak = updatedUser.streak;
      }
      var newBadges = await checkAndAwardBadges(winner.userId);
      if (newBadges.length > 0) {
        r.lastWinner.newBadges = newBadges.map(function(b){ return b.label; });
      }
    }
    // Reset streak for losers
    r.players.forEach(function(p) {
      if (p.userId && p.id !== winner.id) {
        User.findByIdAndUpdate(p.userId, { streak: 0 }).catch(function(){});
      }
    });
  } catch(e) {
    console.error("judge error:", e.message);
    var w = drawers[Math.floor(Math.random()*drawers.length)];
    w.score = (w.score||0) + 1;
    r.lastWinner = { id:w.id, name:w.name, color:w.color, reason:"השופט בחר באקראי" };
  }

  r.phase = "results";
  io.to(r.id).emit("drawings", r.drawings);
  broadcast(r);
}

// ── Sockets ───────────────────────────────────────────────────────────
io.on("connection", function(socket) {
  socket.emit("lobby_list", getLobbyList());

  socket.on("create", function(data) {
    // Clean up any existing room this socket was hosting
    Object.keys(rooms).forEach(function(rid) {
      if (rooms[rid].hostId === socket.id) {
        clearInterval(rooms[rid].timer);
        delete rooms[rid];
      }
    });

    var id = Math.random().toString(36).slice(2,8).toUpperCase();
    var max = Math.min(Math.max(+(data.maxPlayers)||2, 2), 4);
    rooms[id] = {
      id:id, hostId:socket.id, maxPlayers:max,
      players:[{ id:socket.id, name:data.name||"מארח", color:COLORS[0], score:0, userId:data.userId||null }],
      pendingPlayers:[],
      phase:"lobby", round:0, topic:"", drawings:{}, timer:null, timeLeft:0, lastWinner:null, createdAt:Date.now(), usedTopics:[]
    };
    socket.join(id);
    socket.data.roomId = id;
    socket.emit("joined", id);
    broadcast(rooms[id]);
    pushLobby();
  });

  socket.on("join", function(data) {
    var r = rooms[data.roomId];
    if (!r) return socket.emit("err", "חדר לא נמצא");
    if (r.phase === "done" || r.phase === "abandoned") return socket.emit("err", "המשחק כבר נגמר");
    if (r.players.length >= r.maxPlayers) return socket.emit("err", "החדר מלא");
    r.players.push({ id:socket.id, name:data.name||"שחקן", color:COLORS[r.players.length%COLORS.length], score:0, userId:data.userId||null });
    io.to(r.id).emit("player_joined", { name: data.name||"שחקן" });
    socket.join(data.roomId);
    socket.data.roomId = data.roomId;
    socket.emit("joined", data.roomId);
    broadcast(r);
    pushLobby();

    // update gamesPlayed
    if (data.userId) User.findByIdAndUpdate(data.userId, { $inc:{ gamesPlayed:1 } }).catch(function(){});
  });

  socket.on("start", function() {
    var r = rooms[socket.data.roomId];
    if (!r || r.hostId !== socket.id) return;
    if (r.players.length < 2) return socket.emit("err", "צריך לפחות 2 שחקנים");
    // update gamesPlayed for host
    var host = r.players[0];
    if (host && host.userId) User.findByIdAndUpdate(host.userId, { $inc:{ gamesPlayed:1 } }).catch(function(){});
    startRound(r.id);
  });

  socket.on("draw", function(data) {
    var r = rooms[socket.data.roomId];
    if (!r || r.phase !== "drawing") return;
    r.drawings[socket.id] = data.drawing;
    broadcast(r);
    var allDone = r.players.every(function(p){ return r.drawings[p.id]; });
    if (allDone) { clearInterval(r.timer); r.timer = null; judge(r.id); }
  });

  socket.on('buy_time', function() {
    var r = rooms[socket.data&&socket.data.roomId];
    if (!r || r.phase !== 'drawing') return socket.emit('buy_time_result', { ok:false, reason:'אפשר לקנות זמן רק בזמן ציור' });
    var player = r.players.find(function(p){ return p.id===socket.id; });
    if (!player || !player.userId) return socket.emit('buy_time_result', { ok:false, reason:'צריך להתחבר כדי לקנות זמן' });
    User.findById(player.userId).then(function(user) {
      if (!user || (user.coins||0) < 5) return socket.emit('buy_time_result', { ok:false, reason:'אין מספיק מטבעות (צריך 5 🪙)' });
      return User.findByIdAndUpdate(player.userId, { $inc: { coins: -5 } }).then(function() {
        r.timeLeft = (r.timeLeft||0) + 30;
        io.to(r.id).emit('tick', r.timeLeft);
        io.to(r.id).emit('time_bonus', { name: player.name });
        socket.emit('buy_time_result', { ok:true, coinsLeft: (user.coins||0) - 5 });
      });
    }).catch(function(err) {
      console.error('buy_time error:', err.message);
      socket.emit('buy_time_result', { ok:false, reason:'שגיאה בשרת' });
    });
  });

  socket.on("leave_room", function() {
    var r = rooms[socket.data.roomId];
    if (!r) return;
    // if host leaves lobby, delete the room
    if (r.hostId === socket.id && r.phase === "lobby") {
      clearInterval(r.timer);
      delete rooms[r.id];
      pushLobby();
    } else {
      r.players = r.players.filter(function(p){ return p.id !== socket.id; });
      if (r.players.length === 0) { clearInterval(r.timer); delete rooms[r.id]; }
      else broadcast(r);
      pushLobby();
    }
    socket.leave(socket.data.roomId);
    socket.data.roomId = null;
  });

  socket.on("next", function() {
    var r = rooms[socket.data.roomId];
    if (!r || r.hostId !== socket.id) return;
    // Add any pending players
    if (r.pendingPlayers && r.pendingPlayers.length > 0) {
      r.pendingPlayers.forEach(function(p) { r.players.push(p); });
      r.pendingPlayers = [];
      broadcast(r);
    }
    if (r.round >= MAX_ROUNDS) {
      r.phase = "done";
      // Award 5 bonus coins to overall winner (most points)
      var topPlayer = r.players.reduce(function(a,b){ return (a.score||0)>=(b.score||0)?a:b; });
      if (topPlayer.userId) {
        User.findByIdAndUpdate(topPlayer.userId, { $inc: { coins: 5 } }).catch(function(){});
      }
      broadcast(r);
    }
    else startRound(r.id);
  });

  socket.on("disconnect", function() {
    var r = rooms[socket.data&&socket.data.roomId];
    if (!r) return;
    var leftPlayer = r.players.find(function(p){ return p.id === socket.id; });
    var leftName = leftPlayer ? leftPlayer.name : "שחקן";
    r.players = r.players.filter(function(p){ return p.id !== socket.id; });
    if (r.players.length === 0) {
      clearInterval(r.timer);
      delete rooms[r.id];
    } else {
      if (r.hostId === socket.id) r.hostId = r.players[0].id;
      // אם המשחק היה פעיל — עצור ושלח הודעה לשאר
      if (r.phase === "drawing" || r.phase === "judging" || r.phase === "results") {
        clearInterval(r.timer);
        r.timer = null;
        r.phase = "abandoned";
      }
      io.to(r.id).emit("player_left", { name: leftName });
      broadcast(r);
    }
    pushLobby();
  });
});

// Clean up stale rooms every 5 minutes
setInterval(function() {
  var now = Date.now();
  Object.keys(rooms).forEach(function(rid) {
    var r = rooms[rid];
    if (r.phase === "lobby" && now - r.createdAt > 10 * 60 * 1000) {
      clearInterval(r.timer);
      delete rooms[rid];
      pushLobby();
    }
  });
}, 5 * 60 * 1000);

var PORT = process.env.PORT || 3000;
httpServer.listen(PORT, function() { console.log("Server on port " + PORT); });
