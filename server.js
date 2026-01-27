const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
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
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createDeck() {
  const deck = [];
  suits.forEach(s => values.forEach(v => deck.push(v + s)));
  deck.sort(() => Math.random() - 0.5);
  return deck;
}

/* =========================
   SOCKET HANDLING
========================= */

io.on("connection", socket => {

  console.log("CONNECTED:", socket.id);

  /* =========================
     CREATE ROOM
  ========================= */

  socket.on("createRoom", name => {

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

    socket.emit("roomJoined", { code });

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

    socket.emit("roomJoined", { code });
    io.to(code).emit("roomUpdate", room);
  });

  /* =========================
     READY TOGGLE
  ========================= */

  socket.on("ready", code => {

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

    console.log("START GAME RECEIVED", code);
    const room = rooms[code];
    if (!room) return;
    if (room.host !== socket.id) return;

    const allReady = room.players.every(p => p.ready);
    if (!allReady) return;

    const deck = createDeck();
    const hands = {};

    room.players.forEach(p => {
      hands[p.id] = deck.splice(0, 5);
    });

    const tableCard = deck.pop();

    room.game = {
      deck,
      hands,
      tableCard,
      turnIndex: 0,
      order: room.players.map(p => p.id),

      pendingDraw: 0,
      skipCount: 0,
      forcedSuit: null,
      freePlay: false
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

    console.log("PLAY:", socket.id, cards);

    // REMOVE CARDS
    cards.forEach(c => {
      const idx = hand.indexOf(c);
      if (idx !== -1) hand.splice(idx, 1);
    });

    // ===== WIN CHECK =====

    if (hand.length === 0) {

      io.to(code).emit("gameOver", {
        winner: socket.id
      });

      room.game = null;
      return;
    }

    const lastCard = cards[cards.length - 1];
    const value = lastCard.slice(0, -1);
    const suit = lastCard.slice(-1);

    g.freePlay = false;

    /* ===== BURN ===== */

    const sameValue = cards.every(c => c.slice(0,-1) === value);

    if (sameValue && cards.length === 4) {

      g.pendingDraw = 0;
      g.skipCount = 0;
      g.forcedSuit = null;
      g.freePlay = true;

      g.tableCard = lastCard;

      io.to(code).emit("gameUpdate", {
        hands: g.hands,
        tableCard: g.tableCard,
        turnPlayer: socket.id,
        forcedSuit: g.forcedSuit,
        pendingDraw: g.pendingDraw,
        skipCount: g.skipCount,
        effects: { burn: true }
      });

      return;
    }

    /* ===== NORMAL APPLY ===== */

    g.tableCard = lastCard;

    if (value !== "Q") g.forcedSuit = null;

    // GREEN JACK RESET
    if (value === "J" && suit === "♣") {
      g.pendingDraw = 0;
      g.skipCount = 0;
    }

    // +3 STACK
    if (value === "7") {
      g.pendingDraw += 3;
    }

    // ACE STOP
    if (value === "A") {
      g.skipCount++;
    }

    // QUEEN FORCE SUIT
    if (value === "Q") {
      g.forcedSuit = suits[Math.floor(Math.random() * 4)];
    }

    /* ===== NEXT TURN ===== */

    g.turnIndex = (g.turnIndex + 1) % g.order.length;

    if (g.skipCount > 0) {

      g.turnIndex = (g.turnIndex + 1) % g.order.length;
      g.skipCount--;
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

    const currentPlayer = g.order[g.turnIndex];
    if (socket.id !== currentPlayer) return;

    console.log("DRAW:", socket.id);

    let amount = g.pendingDraw > 0 ? g.pendingDraw : 1;

    for (let i = 0; i < amount && g.deck.length; i++) {
      const card = g.deck.pop();
      g.hands[socket.id].push(card);
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

  });

  /* =========================
     DISCONNECT
  ========================= */

  socket.on("disconnect", () => {

    console.log("DISCONNECTED:", socket.id);

    for (const code in rooms) {

      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);

      if (index !== -1) {

        room.players.splice(index, 1);

        if (room.players.length === 0) {
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
