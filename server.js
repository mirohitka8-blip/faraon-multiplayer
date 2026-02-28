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

  // +3 STACK PRIORITA
  if (pendingDraw > 0) {
    if (v === "7") return true;
    if (v === "J" && s === "♣") return true;
    return false;
  }

  // Queen vždy ide
  if (v === "Q") return true;

  // Green Jack vždy ide
  if (v === "J" && s === "♣") return true;

  // Forced suit
  if (forcedSuit) return s === forcedSuit;

  // Normal match
  return v === tv || s === ts;
}

/* =========================
   SOCKET
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
  if (!room) return socket.emit("errorMessage","Room neexistuje");
  if (room.players.length >= 4) return socket.emit("errorMessage","Room je plný");

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
   PLAYER READY
========================= */

socket.on("playerReady", ({ room: code }) => {

  const room = rooms[code];
  if (!room) return;

  const player = room.players.find(p => p.id === socket.id);
  if (!player) return;

  // toggle ready (lepšie ako len true)
  player.ready = !player.ready;

  console.log("READY UPDATE:", room.players);

  io.to(code).emit("roomUpdate", {
    players: room.players,
    host: room.host
  });

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
    forcedSuit: null,
    waitingForQueen: null
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
  const first = cards[0];

  if (!canPlayCard(first, g.tableCard, g.forcedSuit, g.pendingDraw)) {
    console.log("INVALID MOVE");
    return;
  }

  // remove cards
  cards.forEach(c => {
    const idx = hand.indexOf(c);
    if (idx !== -1) hand.splice(idx,1);
  });

  // WIN
  if (hand.length === 0) {
    io.to(code).emit("gameOver", {
      winner: socket.id,
      lastCard: cards[cards.length - 1]
    });
    room.game = null;
    return;
  }

  const last = cards[cards.length - 1];
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
      forcedSuit: null,
      pendingDraw: 0,
      skipCount: 0,
      effects: { burn: true }
    });

    return;
  }

  /* ===== QUEEN ===== */
  if (value === "Q") {

    g.waitingForQueen = socket.id;

    io.to(code).emit("gameUpdate", {
      hands: g.hands,
      tableCard: g.tableCard,
      turnPlayer: socket.id,
      forcedSuit: g.forcedSuit,
      pendingDraw: g.pendingDraw,
      skipCount: g.skipCount,
      queenDecision: true
    });

    return;
  }

  /* ===== ACE ===== */
  if (value === "A") {

    g.skipCount = 1;

    io.to(code).emit("gameUpdate", {
      hands: g.hands,
      tableCard: g.tableCard,
      turnPlayer: socket.id,
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
    g.forcedSuit = null;

    g.turnIndex = (g.turnIndex + 1) % g.order.length;

    io.to(code).emit("gameUpdate", {
      hands: g.hands,
      tableCard: g.tableCard,
      turnPlayer: g.order[g.turnIndex],
      forcedSuit: null,
      pendingDraw: g.pendingDraw,
      skipCount: g.skipCount
    });

    return;
  }

  /* ===== GREEN JACK ===== */
  if (value === "J" && suit === "♣") {

    g.pendingDraw = 0;
    g.skipCount = 0;

    g.turnIndex = (g.turnIndex + 1) % g.order.length;

    io.to(code).emit("gameUpdate", {
      hands: g.hands,
      tableCard: g.tableCard,
      turnPlayer: g.order[g.turnIndex],
      forcedSuit: null,
      pendingDraw: 0,
      skipCount: 0
    });

    return;
  }

  /* ===== RESET FORCED SUIT ===== */
  if (
    g.forcedSuit &&
    suit === g.forcedSuit &&
    value !== "Q"
  ) {
    g.forcedSuit = null;
  }

  /* ===== NORMAL TURN ===== */
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
   STAND ACE
========================= */

socket.on("standAce", ({ room: code }) => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;
  const current = g.order[g.turnIndex];
  if (socket.id !== current) return;

  g.skipCount = 0;
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
   SET SUIT
========================= */

socket.on("setSuit", ({ room: code, suit }) => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;

  if (g.waitingForQueen !== socket.id) return;

  g.forcedSuit = suit;
  g.waitingForQueen = null;
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

});
