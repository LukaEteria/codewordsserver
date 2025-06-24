import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mysql from "mysql2/promise";
import bcrypt from "bcrypt";
import words from "../src/worlds/sityva.js"; // შეცვალე საჭიროებისამებრ
import jwt from 'jsonwebtoken';  // JSON Web Token


const app = express();
app.use(cors({
  origin: "https://spywords.com.ge",  // მხოლოდ ამ დომენზე დაუშვებს კავშირებს
  methods: ["GET", "POST"],
  credentials: true,  // კუკის გამოყენებისათვის
}));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: "https://spywords.com.ge",  // თქვენი აპლიკაციის URL
    methods: ["GET", "POST"],
    credentials: true,  // იგივე, როგორც CORS-ზე
  },
  transports: ['websocket', 'polling'], // Polling fallback
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ✅ MySQL კავშირი
let db;

async function initializeDB() {
  try {
    console.log("Trying to connect to the DB with the following parameters:", {
      host: "sql12.freesqldatabase.com",
      user: "sql12786439",
      database: "sql12786439",
      port: 3306,
    });

    // კავშირის დამყარება
    db = await mysql.createConnection({
      host: "sql12.freesqldatabase.com",
      user: "sql12786439",
      password: "NB9XukN3sz",
      database: "sql12786439",
      port: 3306,
    });

    console.log("✅ MySQL კავშირი წარმატებულია.");
  } catch (error) {
    console.error("❌ MySQL კავშირი ჩავარდა:", error);
    process.exit(1); // stop server if DB connection fails
  }
}

// 🔄 ოთახების მეხსიერება
const rooms = {};

function randomTeam() {
  return Math.random() < 0.5 ? "red" : "blue";
}

function generateBoard(wordList, firstTurn) {
  const shuffledWords = [...wordList]
    .sort(() => 0.5 - Math.random())
    .slice(0, 25);
  const roles = [
    "assassin",
    ...Array(firstTurn === "red" ? 9 : 8).fill("red"),
    ...Array(firstTurn === "blue" ? 9 : 8).fill("blue"),
    ...Array(7).fill("neutral"),
  ].sort(() => 0.5 - Math.random());

  return shuffledWords.map((word, i) => ({
    word,
    role: roles[i],
    revealed: false,
  }));
}

function sendRoomData(roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit("room-data", room);
}

async function roomCheckAndDeleteIfEmpty(roomId) {
  const room = rooms[roomId];
  if (room && room.players.length === 0) {
    await db.query("DELETE FROM rooms WHERE id = ?", [roomId]);
    delete rooms[roomId];
    console.log(`🧹 ოთახი წაიშალა: ${roomId}`);
  }
}

// ✅ რეგისტრაცია
app.post("/api/register", async (req, res) => {
  const { nickname, password, email } = req.body;

  if (!nickname || !password || !email) {
    return res.status(400).json({ error: "ყველა ველი აუცილებელია" });
  }

  try {
    console.log(`Trying to register user: ${nickname}`);

    const [existing] = await db.query(
      "SELECT id FROM users WHERE nickname = ? OR email = ?",
      [nickname, email]
    );
    console.log('Query Results:', existing);  // log query results
    if (existing.length > 0) {
      return res.status(400).json({ error: "ნიკნეიმი ან იმეილი უკვე არსებობს" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      "INSERT INTO users (nickname, password_hash, email, tarigi) VALUES (?, ?, ?, NOW())",
      [nickname, password_hash, email]
    );

    return res.status(200).json({ message: "რეგისტრაცია წარმატებულია" });
  } catch (err) {
    console.error("❌ რეგისტრაციის შეცდომა:", err);
    return res.status(500).json({ error: "სერვერის შეცდომა" });
  }
});

// ✅ ავტორიზაცია
app.post("/api/login", async (req, res) => {
  const { nickname, password } = req.body;

  if (!nickname || !password) {
    return res.status(400).json({ error: "შეავსე ორივე ველი" });
  }

  try {
    const [rows] = await db.query("SELECT id, nickname, password_hash FROM users WHERE nickname = ?", [nickname]);

    if (rows.length === 0) {
      return res.status(400).json({ error: "მომხმარებელი არ მოიძებნა" });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ error: "არასწორი პაროლია" });
    }

    // JWT-ის შექმნა
    const token = jwt.sign(
      { id: user.id, nickname: user.nickname },
      'your-secret-key', // საიდუმლო გასაღები (გაკეთე განსხვავებული!)
      { expiresIn: '1h' }  // გამოგზავნილი token-ის ვადა 1 საათია
    );

    return res.status(200).json({
      message: "ავტორიზაცია წარმატებულია",
      nickname: user.nickname,
      token,  // დაბრუნდება JWT token-ი
    });
  } catch (err) {
    console.error("❌ ავტორიზაციის შეცდომა:", err);
    return res.status(500).json({ error: "სერვერის შეცდომა" });
  }
});

// ✅ Rooms API
app.get("/api/rooms", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM rooms ORDER BY created_at DESC LIMIT 10"
    );
    res.json(rows);
  } catch (err) {
    console.error("Rooms API error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Socket.IO Events
io.on("connection", (socket) => {
  console.log("🔌 კავშირი:", socket.id);

  socket.on("login", async ({ nickname, password }, callback) => {
    try {
      const [rows] = await db.query("SELECT * FROM users WHERE nickname = ?", [
        nickname,
      ]);
      if (rows.length === 0) {
        return callback({
          success: false,
          message: "მომხმარებელი ვერ მოიძებნა",
        });
      }

      const match = await bcrypt.compare(password, rows[0].password_hash);
      if (!match)
        return callback({ success: false, message: "არასწორი პაროლია" });

      callback({ success: true, nickname: rows[0].nickname });
    } catch (err) {
      console.error(err);
      callback({ success: false, message: "სერვერის შეცდომა" });
    }
  });

  socket.on("create-room", async ({ nickname }, callback) => {
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
    if (!rooms[roomId]) return callback("ოთახი არ მოიძებნა");

    rooms[roomId].players.push({
      id: socket.id,
      nickname,
      role: null,
      team: null,
    });
    await db.query(
      "UPDATE rooms SET last_active = NOW(), active = true WHERE id = ?",
      [roomId]
    );
    socket.join(roomId);
    callback(null);
    sendRoomData(roomId);
  });

  socket.on("disconnecting", async () => {
    for (const roomId of socket.rooms) {
      if (rooms[roomId]) {
        rooms[roomId].players = rooms[roomId].players.filter(
          (p) => p.id !== socket.id
        );
        sendRoomData(roomId);
        await roomCheckAndDeleteIfEmpty(roomId);
      }
    }
  });
});

app.listen(PORT, async () => {
  await initializeDB();
  console.log(`🚀 Server listening on port ${PORT}`);
});
