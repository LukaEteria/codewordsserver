import express from "express";
import fs from "fs";
import { createServer } from "https";
import { Server } from "socket.io";
import cors from "cors";
import words from "../src/worlds/sityva.js"; // შეცვალე თუ გინდა ლოკაცია

const app = express();
app.use(cors());

// ✅ SSL სერტიფიკატები
const sslOptions = {
  key: fs.readFileSync("/etc/letsencrypt/live/spywords.com.ge/privkey.pem"),
  cert: fs.readFileSync("/etc/letsencrypt/live/spywords.com.ge/fullchain.pem"),
};

// ✅ HTTPS სერვერის შექმნა
const server = createServer(sslOptions, app);

// ✅ Socket.IO სერვერის კონფიგურაცია
const io = new Server(server, {
  cors: {
    origin: "https://spywords.com.ge",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ✅ ოთახების სტრუქტურა
const rooms = {};

function randomTeam() {
  return Math.random() < 0.5 ? "red" : "blue";
}

function generateBoard(wordList, firstTurn) {
  const shuffledWords = [...wordList].sort(() => 0.5 - Math.random()).slice(0, 25);
  const roles = [
    "assassin",
    ...Array(firstTurn === "red" ? 9 : 8).fill("red"),
    ...Array(firstTurn === "blue" ? 9 : 8).fill("blue"),
    ...Array(7).fill("neutral"),
  ].sort(() => 0.5 - Math.random());

  return shuffledWords.map((word, i) => ({ word, role: roles[i], revealed: false }));
}

function sendRoomData(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit("room-data", room);
}

io.on("connection", (socket) => {
  console.log("🟢 ახალი კავშირი:", socket.id);

  socket.on("create-room", ({ nickname }, callback) => {
    if (!nickname?.trim()) return;
    const roomId = Math.random().toString(36).substring(2, 8);
    const firstTurn = randomTeam();

    rooms[roomId] = {
      players: [{ id: socket.id, nickname, role: null, team: null }],
      board: generateBoard(words, firstTurn),
      started: false,
      turn: firstTurn,
      clue: null,
      clueTeam: null,
      guessesLeft: 0,
      scores: {
        red: firstTurn === "red" ? 9 : 8,
        blue: firstTurn === "blue" ? 9 : 8,
      },
      winner: null,
      creatorId: socket.id,
    };

    socket.join(roomId);
    callback(roomId);
    sendRoomData(roomId);
  });

  socket.on("join-room", ({ roomId, nickname }, callback) => {
    if (!rooms[roomId] || !nickname?.trim()) return callback("Room not found or invalid");
    rooms[roomId].players.push({ id: socket.id, nickname, role: null, team: null });
    socket.join(roomId);
    callback(null);
    sendRoomData(roomId);
  });

  // ✅ დაბრუნება ოთახში
  socket.on("rejoin-room", ({ roomId, nickname }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback("Room not found");

    if (!room.players.some(p => p.id === socket.id)) {
      room.players.push({ id: socket.id, nickname, role: null, team: null });
    }

    socket.join(roomId);
    callback(null);
    sendRoomData(roomId);
  });

  socket.on("set-role", ({ roomId, role, team }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);

    if (role === "spymaster") {
      if (room.players.some(p => p.role === "spymaster" && p.team === team)) return;
    }

    if (player) {
      player.role = role;
      player.team = team;
      sendRoomData(roomId);
    }
  });

  socket.on("set-clue", ({ roomId, clue, number }) => {
    const room = rooms[roomId];
    if (!room || room.winner || room.clue) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== "spymaster" || player.team !== room.turn) return;

    room.clue = { clue, number };
    room.clueTeam = player.team;
    room.guessesLeft = number + 1;
    sendRoomData(roomId);
  });

  socket.on("reveal-word", ({ roomId, word }) => {
    const room = rooms[roomId];
    if (!room || room.winner || room.guessesLeft <= 0) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.role !== "operative" || player.team !== room.turn) return;

    const wordObj = room.board.find(w => w.word === word);
    if (!wordObj || wordObj.revealed) return;
    wordObj.revealed = true;

    if (wordObj.role === "assassin") {
      room.winner = room.turn === "red" ? "blue" : "red";
    } else if (wordObj.role === room.turn) {
      room.scores[room.turn]--;
      room.guessesLeft--;
      if (room.scores[room.turn] === 0) {
        room.winner = room.turn;
      } else if (room.guessesLeft === 0) {
        room.turn = room.turn === "red" ? "blue" : "red";
      }
    } else {
      room.turn = room.turn === "red" ? "blue" : "red";
      room.guessesLeft = 0;
    }

    if (room.winner || room.guessesLeft === 0) {
      room.clue = null;
      room.clueTeam = null;
    }

    sendRoomData(roomId);
  });

  socket.on("end-turn", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.winner) return;
    room.turn = room.turn === "red" ? "blue" : "red";
    room.clue = null;
    room.clueTeam = null;
    room.guessesLeft = 0;
    sendRoomData(roomId);
  });

  socket.on("reset-game", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.board = generateBoard(words, room.turn);
    room.winner = null;
    room.clue = null;
    room.clueTeam = null;
    room.guessesLeft = 0;
    room.turn = room.turn === "red" ? "blue" : "red";
    room.scores = {
      red: room.turn === "red" ? 9 : 8,
      blue: room.turn === "blue" ? 9 : 8,
    };

    room.players.forEach(player => {
      player.role = "operative";
    });

    sendRoomData(roomId);
  });

  socket.on("new-game", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const firstTurn = randomTeam();
    room.board = generateBoard(words, firstTurn);
    room.turn = firstTurn;
    room.clue = null;
    room.clueTeam = null;
    room.guessesLeft = 0;
    room.winner = null;
    room.scores = {
      red: firstTurn === "red" ? 9 : 8,
      blue: firstTurn === "blue" ? 9 : 8,
    };
    sendRoomData(roomId);
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (rooms[roomId]) {
        rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
        sendRoomData(roomId);
      }
    }
  });
});

// ✅ გაშვების პორტი
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`✅ HTTPS Socket.IO სერვერი გაშვებულია პორტზე ${PORT}`);
});
