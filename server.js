const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("SERVER RUNNING ON", PORT);
});

/* =========================
   GLOBAL STATE
========================= */

const rooms = {};

const suits = ["♥","♦","♣","♠"];
const values = ["7","8","9","10","J","Q","K","A"];

/* =========================
   HELPERS
========================= */

function generateRoomCode() {
  return Math.random().toString(36).substring(2,7).toUpperCase();
}

function createDeck() {
  const deck = [];
  suits.forEach(s => values.forEach(v => deck.push(v + s)));
  return deck.sort(() => Math.random() - 0.5);
}

function canPlayCard(card, tableCard, forcedSuit, pendingDraw) {

  const v = card.slice(0,-1);
  const s = card.slice(-1);

  const tv = tableCard.slice(0,-1);
  const ts = tableCard.slice(-1);

  // +3 chain
  if (pendingDraw > 0) {
    if (v === "7") return true;
    if (v === "J" && s === "♣") return true;
    return false;
  }

  // forced suit
  if (forcedSuit) return s === forcedSuit;

  // green jack wildcard
  if (v === "J" && s === "♣") return true;

  // queen always playable
  if (v === "Q") return true;

  return v === tv || s === ts;
}

/* =========================
   SOCKET SERVER
========================= */

io.on("connection", socket => {

  console.log("CONNECTED:", socket.id);

/* =========================
   CREATE ROOM
========================= */

socket.on("createRoom", payload => {

  const name = typeof payload === "string"
    ? payload
    : payload?.name;


  const code = generateRoomCode();

  rooms[code] = {
    host: socket.id,
    players: [{
      id: socket.id,
      name,
      ready: false
    }],
    game: null
  };

  socket.join(code);

  socket.emit("roomJoined", {
    roomCode: code,
    isHost: true,
    players: rooms[code].players
  });

  io.to(code).emit("roomUpdate", rooms[code]);
});

/* =========================
   JOIN ROOM
========================= */

socket.on("joinRoom", ({ code, name }) => {

  const room = rooms[code];

  if (!room) {
    socket.emit("errorMessage", "Room neexistuje");
    return;
  }

  if (room.players.length >= 4) {
    socket.emit("errorMessage", "Room je plný");
    return;
  }

  room.players.push({
    id: socket.id,
    name,
    ready: false
  });

  socket.join(code);

  socket.emit("roomJoined", {
    roomCode: code,
    isHost: false,
    players: room.players
  });

  io.to(code).emit("roomUpdate", room);
});

/* =========================
   READY TOGGLE
========================= */

socket.on("playerReady", code => {

  const room = rooms[code];
  if (!room) return;

  const p = room.players.find(p => p.id === socket.id);
  if (!p) return;

  p.ready = !p.ready;

  io.to(code).emit("roomUpdate", room);
});

/* =========================
   KICK PLAYER
========================= */

socket.on("kickPlayer", ({ code, playerId }) => {

  const room = rooms[code];
  if (!room) return;

  if (room.host !== socket.id) return;

  room.players = room.players.filter(p => p.id !== playerId);

  io.to(playerId).emit("kicked");
  io.to(code).emit("roomUpdate", room);
});

/* =========================
   START GAME
========================= */

socket.on("startGame", code => {

  const room = rooms[code];
  if (!room) return;

  if (room.host !== socket.id) return;
  if (!room.players.every(p => p.ready)) return;

  const deck = createDeck();
  const hands = {};

  room.players.forEach(p => {
    hands[p.id] = deck.splice(0,5);
  });

  const tableCard = deck.pop();

  room.game = {
    deck,
    hands,
    tableCard,

    order: room.players.map(p => p.id),
    turnIndex: 0,

    pendingDraw: 0,
    skipCount: 0,
    forcedSuit: null
  };

  io.to(code).emit("gameStarted", room.game);
});

/* =========================
   PLAY CARD
========================= */

socket.on("playCard", ({ room: code, cards }) => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;

  const current = g.order[g.turnIndex];
  if (socket.id !== current) return;

  const hand = g.hands[socket.id];

  // ===== SERVER VALIDATION =====

  const first = cards[0];

  if (!canPlayCard(first, g.tableCard, g.forcedSuit, g.pendingDraw)) {
    console.log("INVALID MOVE BLOCKED");
    return;
  }

  // ===== REMOVE CARDS =====

  // ===== REMOVE CARDS =====

cards.forEach(c => {
  const i = hand.indexOf(c);
  if (i !== -1) hand.splice(i, 1);
});


// ===== WIN CHECK =====

if (hand.length === 0) {

  io.to(code).emit("gameOver", {
    winner: socket.id
  });

  room.game = null;
  return;
}


  const last = cards[cards.length-1];
  const value = last.slice(0,-1);
  const suit = last.slice(-1);

  g.tableCard = last;

/* ===== BURN ===== */

const sameValue = cards.every(c => c.slice(0,-1) === value);

if (sameValue && cards.length === 4) {

  g.pendingDraw = 0;
  g.skipCount = 0;
  g.forcedSuit = null;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: socket.id,
    effects: { burn:true }
  });

  return;
}

/* ===== ACE STOP ===== */

if (value === "A") {

  // nastav stopku pre ďalšieho hráča
  g.skipCount = 1;

  // posuň turn na hráča ktorý má reagovať
  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: g.order[g.turnIndex],
    forcedSuit: g.forcedSuit,
    pendingDraw: g.pendingDraw,
    skipCount: g.skipCount,
    aceDecision: true
  });

  return;
}


/* ===== +3 STACK ===== */

if (value === "7") {

  g.pendingDraw += 3;

  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: g.order[g.turnIndex],
    forcedSuit: g.forcedSuit,
    pendingDraw: g.pendingDraw,
    skipCount: g.skipCount
  });

  return;
}



/* ===== GREEN JACK ===== */

if (value === "J" && suit === "♣") {
  g.pendingDraw = 0;
  g.skipCount = 0;
}

/* ===== QUEEN ===== */

if (value === "Q") {
  g.forcedSuit = suits[Math.floor(Math.random()*4)];
} else {
  g.forcedSuit = null;
}

/* ===== NORMAL NEXT TURN ===== */

g.turnIndex = (g.turnIndex + 1) % g.order.length;

// consume ace skip
if (g.skipCount > 0) {
  g.turnIndex = (g.turnIndex + 1) % g.order.length;
  g.skipCount = 0;
}


io.to(code).emit("gameUpdate", {
  hands: g.hands,
  tableCard: g.tableCard,
  turnPlayer: g.order[g.turnIndex],
  forcedSuit: g.forcedSuit,
  pendingDraw: g.pendingDraw,
  skipCount: g.skipCount
});

});

/* =========================
   DRAW CARD
========================= */

socket.on("drawCard", code => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;

  const current = g.order[g.turnIndex];
  if (socket.id !== current) return;

/* ===== +3 FORCED DRAW ===== */

if (g.pendingDraw > 0) {

  const amount = g.pendingDraw;

  for (let i=0;i<amount && g.deck.length;i++) {
    g.hands[socket.id].push(g.deck.pop());
  }

  g.pendingDraw = 0;

  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: g.order[g.turnIndex],
    forcedSuit: g.forcedSuit,
    pendingDraw: g.pendingDraw,
    skipCount: g.skipCount
  });

  return;
}

/* ===== NORMAL DRAW ===== */

if (!g.deck.length) return;

g.hands[socket.id].push(g.deck.pop());

g.turnIndex = (g.turnIndex + 1) % g.order.length;

io.to(code).emit("gameUpdate", {
  hands: g.hands,
  tableCard: g.tableCard,
  turnPlayer: g.order[g.turnIndex],
  forcedSuit: g.forcedSuit,
  pendingDraw: g.pendingDraw,
  skipCount: g.skipCount
});

});

/* =========================
   DISCONNECT
========================= */

socket.on("standAce", code => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;

  const current = g.order[g.turnIndex];

  // iba hráč na rade môže stáť
  if (socket.id !== current) return;

  // spotrebuj stopku
  g.skipCount = 0;

  // posuň turn
  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: g.order[g.turnIndex],
    forcedSuit: g.forcedSuit,
    pendingDraw: g.pendingDraw,
    skipCount: g.skipCount
  });

});


socket.on("disconnect", () => {

  for (const code in rooms) {

    const room = rooms[code];
    const index = room.players.findIndex(p => p.id === socket.id);

    if (index !== -1) {

      room.players.splice(index,1);

      if (!room.players.length) {
        delete rooms[code];
        return;
      }

      if (room.host === socket.id) {
        room.host = room.players[0].id;
      }

      io.to(code).emit("roomUpdate", room);
    }
  }
});

});
