const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

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
