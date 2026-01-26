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

/* ===============================
   GLOBAL ROOMS STORAGE
================================ */

const rooms = {};

/* ===============================
   HELPERS
================================ */

function generateRoomCode() {

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function createDeck() {

  const suits = ["♥","♦","♣","♠"];
  const values = ["7","8","9","10","J","Q","K","A"];

  const deck = [];

  suits.forEach(s =>
    values.forEach(v => deck.push(v + s))
  );

  return deck.sort(() => Math.random() - 0.5);
}

/* ===============================
   SOCKET.IO
================================ */

io.on("connection", socket => {

  console.log("CONNECTED:", socket.id);

  /* ===== CREATE ROOM ===== */

  socket.on("createRoom", ({ name }) => {

    const code = generateRoomCode();

    rooms[code] = {
      hostId: socket.id,
      players: [
        {
          id: socket.id,
          name,
          ready: false
        }
      ],
      started: false,
      game: null
    };

    socket.join(code);

    socket.emit("roomJoined", {
      roomCode: code,
      isHost: true,
      players: rooms[code].players
    });

    console.log("ROOM CREATED:", code);
  });

  /* ===== JOIN ROOM ===== */

  socket.on("joinRoom", ({ name, code }) => {

    const room = rooms[code];

    if (!room) {
      socket.emit("errorMessage", "Miestnosť neexistuje");
      return;
    }

    if (room.players.length >= 4) {
      socket.emit("errorMessage", "Miestnosť je plná");
      return;
    }

    room.players.push({
      id: socket.id,
      name,
      ready: false
    });

    socket.join(code);

    io.to(code).emit("roomUpdate", room.players);

    socket.emit("roomJoined", {
      roomCode: code,
      isHost: false,
      players: room.players
    });

    console.log("PLAYER JOINED:", code);
  });

  /* ===== READY ===== */

  socket.on("playerReady", (code) => {

    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.ready = !player.ready;

    io.to(code).emit("roomUpdate", room.players);
  });

  /* ===== START GAME ===== */

  socket.on("startGame", (code) => {

    const room = rooms[code];
    if (!room) return;

    if (socket.id !== room.hostId) return;

    if (room.players.length < 2) {
      socket.emit("errorMessage", "Potrební sú aspoň 2 hráči");
      return;
    }

    const allReady = room.players.every(p => p.ready);

    if (!allReady) {
      socket.emit("errorMessage", "Nie všetci sú READY");
      return;
    }

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
      order: room.players.map(p => p.id)
    };

    room.started = true;

    io.to(code).emit("gameStarted", {
      hands,
      tableCard,
      turnPlayer: room.game.order[0]
    });

    console.log("GAME STARTED:", code);
  });

  /* ===== PLAY CARD ===== */

  socket.on("playCard", ({ room, cards }) => {

    const r = rooms[room];
    if (!r || !r.game) return;

    const g = r.game;

    // kontrola tahu
    if (g.order[g.turnIndex] !== socket.id) return;

    // odstráň karty z ruky hráča
    cards.forEach(card => {

      const idx = g.hands[socket.id].indexOf(card);

      if (idx !== -1) {
        g.hands[socket.id].splice(idx, 1);
      }

    });

    // posledná karta ide na stôl
    g.tableCard = cards[cards.length - 1];

    // ďalší hráč
    g.turnIndex = (g.turnIndex + 1) % g.order.length;

    io.to(room).emit("gameUpdate", {
      hands: g.hands,
      tableCard: g.tableCard,
      turnPlayer: g.order[g.turnIndex]
    });

  });

  /* ===== KICK PLAYER ===== */

  socket.on("kickPlayer", ({ code, playerId }) => {

    const room = rooms[code];
    if (!room) return;

    if (socket.id !== room.hostId) return;

    room.players = room.players.filter(p => p.id !== playerId);

    io.to(playerId).emit("kicked");

    io.to(code).emit("roomUpdate", room.players);

  });

  /* ===== DISCONNECT ===== */

  socket.on("disconnect", () => {

    console.log("DISCONNECTED:", socket.id);

    for (const code in rooms) {

      const room = rooms[code];

      const index = room.players.findIndex(p => p.id === socket.id);

      if (index !== -1) {

        const wasHost = room.players[index].id === room.hostId;

        room.players.splice(index, 1);

        // nový host
        if (wasHost && room.players.length) {
          room.hostId = room.players[0].id;
        }

        // zruš miestnosť ak prázdna
        if (!room.players.length) {

          delete rooms[code];

        } else {

          io.to(code).emit("roomUpdate", room.players);

        }

        break;
      }
    }

  });

});

/* ===============================
   SERVER START
================================ */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("SERVER RUNNING ON PORT", PORT);
});
