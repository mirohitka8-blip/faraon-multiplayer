const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const rooms = {};
function generateRoomCode() {

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

let waitingPlayer = null;

io.on("connection", socket => {

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
    started: false
  };

  socket.join(code);

  socket.emit("roomJoined", {
    roomCode: code,
    isHost: true,
    players: rooms[code].players
  });

  console.log("ROOM CREATED:", code);
});
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

  socket.on("playerReady", (code) => {

  const room = rooms[code];
  if (!room) return;

  const player = room.players.find(p => p.id === socket.id);
  if (!player) return;

  player.ready = !player.ready;

  io.to(code).emit("roomUpdate", room.players);
});


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

  room.started = true;

  io.to(code).emit("gameStarted");

  console.log("GAME STARTED:", code);
});


  socket.on("kickPlayer", ({ code, playerId }) => {

  const room = rooms[code];
  if (!room) return;

  if (socket.id !== room.hostId) return;

  room.players = room.players.filter(p => p.id !== playerId);

  io.to(playerId).emit("kicked");

  io.to(code).emit("roomUpdate", room.players);
});

socket.on("disconnect", () => {

  for (const code in rooms) {

    const room = rooms[code];

    const index = room.players.findIndex(p => p.id === socket.id);

    if (index !== -1) {

      const wasHost = room.players[index].id === room.hostId;

      room.players.splice(index, 1);

      // ak odišiel host → nový host
      if (wasHost && room.players.length) {
        room.hostId = room.players[0].id;
      }

      if (!room.players.length) {
        delete rooms[code];
      } else {
        io.to(code).emit("roomUpdate", room.players);
      }

      break;
    }
  }

});


  console.log("Player connected:", socket.id);

  if (waitingPlayer) {

    const room = "room-" + socket.id;

    socket.join(room);
    waitingPlayer.join(room);

    io.to(room).emit("gameStart");

    waitingPlayer = null;

  } else {
    waitingPlayer = socket;
  }

  socket.on("playCard", data => {
    socket.to(data.room).emit("enemyPlayed", data);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });

});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
