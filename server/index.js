// ✅ dependencies
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mysql from "mysql2/promise";
import words from "../src/worlds/sityva.js";

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ✅ connect to MySQL
let db;
try {
  db = await mysql.createConnection({
    host: "spywords.com.ge",
    user: "hs0003365_hs0003365",
    password: "E0CSHGVu1{dk",
    database: "hs0003365_spywords",
  });
  console.log("✅ MySQL connection established.");
} catch (error) {
  console.error("❌ MySQL connection failed:", error);
  process.exit(1);
}

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
  if (room) io.to(roomId).emit("room-data", room);
}

// ✅ check and delete room if empty
async function roomCheckAndDeleteIfEmpty(roomId) {
  const room = rooms[roomId];
  if (room && room.players.length === 0) {
    console.log(`🧹 ოთახი ცარიელია. ვშლით ბაზიდან: ${roomId}`);
    await db.query("DELETE FROM rooms WHERE id = ?", [roomId]);
    delete rooms[roomId];
  }
}

io.on("connection", (socket) => {
  console.log("🟢 ახალი კავშირი:", socket.id);

  socket.on("create-room", async ({ nickname }, callback) => {
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

    await db.query(
      "INSERT INTO rooms (id, creator, created_at, last_active, active) VALUES (?, ?, NOW(), NOW(), true)",
      [roomId, nickname]
    );

    socket.join(roomId);
    callback(roomId);
    sendRoomData(roomId);
  });

  socket.on("join-room", async ({ roomId, nickname }, callback) => {
    if (!rooms[roomId] || !nickname?.trim()) return callback("Room not found or invalid");
    rooms[roomId].players.push({ id: socket.id, nickname, role: null, team: null });

    await db.query("UPDATE rooms SET last_active = NOW(), active = true WHERE id = ?", [roomId]);

    socket.join(roomId);
    callback(null);
    sendRoomData(roomId);
  });

  socket.on("rejoin-room", async ({ roomId, nickname }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback("Room not found");

    if (!room.players.some(p => p.id === socket.id)) {
      room.players.push({ id: socket.id, nickname, role: null, team: null });
    }

    await db.query("UPDATE rooms SET last_active = NOW(), active = true WHERE id = ?", [roomId]);

    socket.join(roomId);
    callback(null);
    sendRoomData(roomId);
  });

  socket.on("set-role", ({ roomId, role, team }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);

    if (role === "spymaster" && room.players.some(p => p.role === "spymaster" && p.team === team)) return;

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

  socket.on("disconnecting", async () => {
    for (const roomId of socket.rooms) {
      if (rooms[roomId]) {
        rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
        sendRoomData(roomId);
        await roomCheckAndDeleteIfEmpty(roomId);
      }
    }
  });
});
app.get("/api/rooms", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM rooms ORDER BY created_at DESC LIMIT 10");
    res.json(rows);
  } catch (err) {
    console.error("Rooms API error:", err);
    res.status(500).json({ error: "Server error" });
  }
});
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
