// =============================================
// PYTHON HUNTER v4 — SERVER.JS
// Node.js + Socket.IO + MongoDB Backend
// =============================================

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.json()); // ให้เซิร์ฟเวอร์อ่านข้อมูลแบบ JSON ได้

// 🔴 นำลิงก์ของคุณมาใส่ตรงนี้ 🔴
const MONGO_URI = "mongodb+srv://mikzz2549_db_user:<082184822m>@cluster0.j8hj9u8.mongodb.net/?appName=Cluster0";

// เชื่อมต่อ MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ DATABASE CONNECTED!'))
  .catch(err => console.error('❌ DATABASE CONNECTION ERROR:', err));

// สร้างโครงสร้างตารางคะแนน (Schema)
const ScoreSchema = new mongoose.Schema({
  name: String,
  score: Number,
  mode: String,
  date: { type: Date, default: Date.now }
});
const Score = mongoose.model('Score', ScoreSchema);

// API ดึงกระดานคะแนน 15 อันดับแรก
app.get('/api/leaderboard', async (req, res) => {
  try {
    const topScores = await Score.find().sort({ score: -1 }).limit(15);
    res.json(topScores);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// API บันทึกคะแนนใหม่
app.post('/api/leaderboard', async (req, res) => {
  try {
    const { name, score, mode } = req.body;
    const newScore = new Score({ name, score, mode });
    await newScore.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../client')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));

// =============================================
// MULTIPLAYER ENGINE (Socket.io)
// =============================================
const rooms = new Map();
const players = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const QUESTIONS = require('./data/questions');
function getQuestions(mode) {
  let pool = mode === 'SURVIVAL' ? QUESTIONS.filter(q => q.level >= 6) : QUESTIONS.filter(q => q.mode === mode);
  if (!pool.length) pool = QUESTIONS;
  return shuffleArray(pool);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName, mode, timeLimit }) => {
    const code = generateRoomCode();
    const tl = parseInt(timeLimit) || 60;
    const winScoreMap = { 60: 800, 120: 1500, 180: 2000 };
    const itemsMap = { 60: 1, 120: 2, 180: 3 };

    const room = {
      code, hostId: socket.id, mode: mode || 'BASICS', timeLimit: tl,
      winScore: winScoreMap[tl] || 800, defaultItems: itemsMap[tl] || 1,
      status: 'waiting', players: new Map(), questions: [], questionIndex: 0, globalTimer: tl
    };
    const player = { socketId: socket.id, name: (playerName || 'PLAYER').toUpperCase().slice(0, 12), score: 0, hp: 100, combo: 0, hints: room.defaultItems, potions: room.defaultItems, skips: room.defaultItems, ready: false, done: false };
    
    room.players.set(socket.id, player); rooms.set(code, room); players.set(socket.id, { roomCode: code, name: player.name });
    socket.join(code);
    socket.emit('room_created', { roomCode: code, mode: room.mode, timeLimit: room.timeLimit });
    socket.emit('room_update', serializeRoom(room));
  });

  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = roomCode?.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', 'ไม่พบห้อง');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'เกมเริ่มแล้ว');
    if (room.players.size >= 8) return socket.emit('error_msg', 'ห้องเต็ม');

    const player = { socketId: socket.id, name: (playerName || 'PLAYER').toUpperCase().slice(0, 12), score: 0, hp: 100, combo: 0, hints: room.defaultItems, potions: room.defaultItems, skips: room.defaultItems, ready: false, done: false };
    room.players.set(socket.id, player); players.set(socket.id, { roomCode: code, name: player.name });
    
    socket.join(code);
    socket.emit('room_joined', { roomCode: code, mode: room.mode, timeLimit: room.timeLimit });
    io.to(code).emit('room_update', serializeRoom(room));
    io.to(code).emit('chat_msg', { system: true, text: `${player.name} เข้าร่วมห้อง!` });
  });

  socket.on('player_ready', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'waiting') return;
    const player = room.players.get(socket.id); if (!player) return;
    player.ready = !player.ready;
    io.to(info.roomCode).emit('room_update', serializeRoom(room));
  });

  socket.on('start_game', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.hostId !== socket.id || room.status !== 'waiting') return;

    room.status = 'playing'; room.questions = getQuestions(room.mode); room.questionIndex = 0; room.globalTimer = room.timeLimit;
    room.players.forEach(p => { p.score = 0; p.hp = 100; p.combo = 0; p.done = false; p.hints = room.defaultItems; p.potions = room.defaultItems; p.skips = room.defaultItems; });
    
    io.to(info.roomCode).emit('game_started', { mode: room.mode, timeLimit: room.timeLimit, winScore: room.winScore, question: room.questions[0], defaultItems: room.defaultItems });
    startRoomTimer(room, info.roomCode);
  });

  socket.on('submit_answer', ({ answer }) => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id); if (!player || player.done) return;

    const qIdx = player.questionIndex || 0;
    const question = room.questions[qIdx % room.questions.length]; if (!question) return;

    if ((answer || '').toLowerCase().trim() === question.ans.toLowerCase().trim()) {
      player.combo = (player.combo || 0) + 1;
      player.score += 150 + (player.combo >= 5 ? 75 : player.combo >= 3 ? 50 : 0);
      player.questionIndex = (qIdx + 1) % room.questions.length;
      socket.emit('answer_result', { correct: true, earned: 150 + (player.combo >= 5 ? 75 : player.combo >= 3 ? 50 : 0), combo: player.combo, score: player.score, nextQuestion: room.questions[player.questionIndex] });
      
      if (player.score >= room.winScore) { player.done = true; socket.emit('player_won', { score: player.score }); }
    } else {
      player.combo = 0; player.hp = Math.max(0, player.hp - 20);
      socket.emit('answer_result', { correct: false, hp: player.hp, combo: 0, score: player.score });
      if (player.hp <= 0) { player.done = true; socket.emit('player_eliminated'); }
    }
    io.to(info.roomCode).emit('score_update', getScoreboard(room));
    checkAllDone(room, info.roomCode);
  });

  socket.on('use_item', ({ item }) => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id); if (!player || player.done) return;
    const qIdx = player.questionIndex || 0; const question = room.questions[qIdx % room.questions.length];

    if (item === 'hint' && player.hints > 0) {
      player.hints--; player.score = Math.max(0, player.score - 50);
      socket.emit('item_used', { item: 'hint', hint: question.ans.substring(0, Math.max(1, Math.ceil(question.ans.length * 0.4))), score: player.score, hints: player.hints });
    } else if (item === 'potion' && player.potions > 0 && player.hp < 100) {
      player.potions--; player.hp = Math.min(100, player.hp + 30);
      socket.emit('item_used', { item: 'potion', hp: player.hp, potions: player.potions });
    } else if (item === 'skip' && player.skips > 0) {
      player.skips--; player.score = Math.max(0, player.score - 100); player.combo = 0; player.questionIndex = (qIdx + 1) % room.questions.length;
      socket.emit('item_used', { item: 'skip', score: player.score, skips: player.skips, nextQuestion: room.questions[player.questionIndex] });
    }
    io.to(info.roomCode).emit('score_update', getScoreboard(room));
  });

  socket.on('disconnect', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); players.delete(socket.id); if (!room) return;
    room.players.delete(socket.id); io.to(info.roomCode).emit('chat_msg', { system: true, text: `${info.name} ออกจากห้อง` });
    if (room.players.size === 0) { clearRoomTimer(room); return rooms.delete(info.roomCode); }
    if (room.hostId === socket.id) { room.hostId = room.players.keys().next().value; io.to(room.hostId).emit('you_are_host'); }
    io.to(info.roomCode).emit('room_update', serializeRoom(room)); checkAllDone(room, info.roomCode);
  });
  
  socket.on('send_chat', ({ text }) => {
    const info = players.get(socket.id); if (!info || !text) return;
    io.to(info.roomCode).emit('chat_msg', { name: info.name, text: text.trim().slice(0, 80) });
  });
});

function startRoomTimer(room, roomCode) {
  clearRoomTimer(room);
  room.timerInterval = setInterval(() => {
    room.globalTimer--; io.to(roomCode).emit('timer_tick', { time: room.globalTimer });
    if (room.globalTimer <= 0) { clearRoomTimer(room); endGame(room, roomCode); }
  }, 1000);
}
function clearRoomTimer(room) { if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; } }
function checkAllDone(room, roomCode) {
  let allDone = true; room.players.forEach(p => { if (!p.done) allDone = false; });
  if (allDone && room.status === 'playing') { clearRoomTimer(room); endGame(room, roomCode); }
}
function endGame(room, roomCode) {
  if (room.status === 'ended') return; room.status = 'ended';
  io.to(roomCode).emit('game_ended', { scoreboard: getScoreboard(room) });
  setTimeout(() => { clearRoomTimer(room); rooms.delete(roomCode); }, 5 * 60 * 1000);
}
function getScoreboard(room) {
  const arr = []; room.players.forEach(p => arr.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, done: p.done }));
  return arr.sort((a, b) => b.score - a.score);
}
function serializeRoom(room) {
  const arr = []; room.players.forEach(p => arr.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, ready: p.ready, done: p.done }));
  return { code: room.code, hostId: room.hostId, mode: room.mode, timeLimit: room.timeLimit, status: room.status, players: arr.sort((a, b) => b.score - a.score) };
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`🚀 SERVER + DATABASE RUNNING ON PORT ${PORT}`));