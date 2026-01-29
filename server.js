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

  const v = card.slice(0, -1);
  const s = card.slice(-1);

  const tv = tableCard.slice(0, -1);
  const ts = tableCard.slice(-1);

  /* ===== GREEN JACK WILDCARD ===== */
  // J♣ can be played anytime
  if (v === "J" && s === "♣") return true;
  // anything can be played on J♣
  if (tv === "J" && ts === "♣") return true;
  /* ===== +3 STACK ===== */
  if (pendingDraw > 0) {
    if (v === "7") return true;
    if (v === "J" && s === "♣") return true;
    return false;
  }
  /* ===== FORCED SUIT (QUEEN) ===== */
  if (forcedSuit) {
    return s === forcedSuit;
  }
  /* ===== QUEEN ALWAYS PLAYABLE ===== */
  if (v === "Q") return true;
  /* ===== NORMAL MATCH ===== */
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

  const currentPlayer = g.order[g.turnIndex];
  if (socket.id !== currentPlayer) return;

  const hand = g.hands[socket.id];

  /* =========================
     VALIDATION
  ========================= */

  const first = cards[0];

  if (!canPlayCard(first, g.tableCard, g.forcedSuit, g.pendingDraw)) {
    console.log("INVALID MOVE BLOCKED");
    return;
  }

  /* =========================
     REMOVE CARDS
  ========================= */

  cards.forEach(c => {
    const idx = hand.indexOf(c);
    if (idx !== -1) hand.splice(idx, 1);
  });

  const last = cards[cards.length - 1];
  const value = last.slice(0, -1);
  const suit = last.slice(-1);

  g.tableCard = last;

  /* =========================
     BURN
  ========================= */

  const sameValue = cards.every(c => c.slice(0, -1) === value);

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
      effects: { burn: true },
      action: { type: "play", card: last }
    });

    return;
  }

  /* =========================
     QUEEN
  ========================= */

  if (value === "Q") {

    io.to(code).emit("gameUpdate", {
      hands: g.hands,
      tableCard: g.tableCard,
      turnPlayer: socket.id,
      forcedSuit: null,
      pendingDraw: g.pendingDraw,
      skipCount: g.skipCount,
      queenDecision: true,
      action: { type: "play", card: last }
    });

    return;
  }

  /* =========================
     ACE
  ========================= */

  if (value === "A") {

    g.skipCount = 1;
    g.turnIndex = (g.turnIndex + 1) % g.order.length;

    io.to(code).emit("gameUpdate", {
      hands: g.hands,
      tableCard: g.tableCard,
      turnPlayer: g.order[g.turnIndex],
      forcedSuit: g.forcedSuit,
      pendingDraw: g.pendingDraw,
      skipCount: g.skipCount,
      aceDecision: true,
      action: { type: "play", card: last }
    });

    return;
  }

  /* =========================
     +3 STACK
  ========================= */

  if (value === "7") {

  g.pendingDraw += 3;

  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: g.order[g.turnIndex],
    forcedSuit: g.forcedSuit,
    pendingDraw: g.pendingDraw,
    skipCount: g.skipCount,
    effects: {
      seven: true,
      penaltyValue: g.pendingDraw
    }
  });

  return;
}

  /* =========================
     GREEN JACK RESET
  ========================= */

  /* ===== GREEN JACK RESET ===== */

if (value === "J" && suit === "♣") {

  // reset penalties
  g.pendingDraw = 0;
  g.skipCount = 0;

  // move to next player
  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: g.order[g.turnIndex],
    forcedSuit: null,
    pendingDraw: g.pendingDraw,
    skipCount: g.skipCount,
    effects: {
      greenJack: true
    }
  });

  return;
}



  g.forcedSuit = null;

  /* =========================
     NORMAL TURN
  ========================= */

  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
    hands: g.hands,
    tableCard: g.tableCard,
    turnPlayer: g.order[g.turnIndex],
    forcedSuit: g.forcedSuit,
    pendingDraw: g.pendingDraw,
    skipCount: g.skipCount,
    action: { type: "play", card: last }
  });

  /* =========================
     WIN CHECK (AFTER UPDATE)
  ========================= */

  if (hand.length === 0) {

    io.to(code).emit("gameOver", {
      winner: socket.id
    });

    room.game = null;
  }

});


socket.on("standAce", ({ room: code }) => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;

  const current = g.order[g.turnIndex];
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




socket.on("setSuit", ({ room: code, suit }) => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;

  const current = g.order[g.turnIndex];
  if (socket.id !== current) return;

  g.forcedSuit = suit;

  // posuň turn ďalej
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
   DRAW CARD
========================= */
socket.on("drawCard", code => {

  const room = rooms[code];
  if (!room || !room.game) return;

  const g = room.game;

  const current = g.order[g.turnIndex];
  if (socket.id !== current) return;

  /* =========================
     +3 PENALTY DRAW
  ========================= */

  if (g.pendingDraw > 0) {

    const amount = g.pendingDraw;

    for (let i = 0; i < amount && g.deck.length; i++) {
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
  skipCount: g.skipCount,

  action: {
    type: "draw",
    player: socket.id
  }
});



    return;
  }

  /* =========================
     NORMAL DRAW
  ========================= */

  if (!g.deck.length) return;

  g.hands[socket.id].push(g.deck.pop());

  g.turnIndex = (g.turnIndex + 1) % g.order.length;

  io.to(code).emit("gameUpdate", {
  hands: g.hands,
  tableCard: g.tableCard,
  turnPlayer: g.order[g.turnIndex],
  forcedSuit: g.forcedSuit,
  pendingDraw: g.pendingDraw,
  skipCount: g.skipCount,

    action: {
    type: "draw",
    player: socket.id
  }
});


});


/* =========================
   DISCONNECT
========================= */

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
