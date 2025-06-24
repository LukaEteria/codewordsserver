import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mysql from "mysql2/promise";
import bcrypt from "bcrypt";
import jwt from 'jsonwebtoken';  // JSON Web Token
import dotenv from 'dotenv';  // Load environment variables

dotenv.config();  // Loads environment variables from .env file

const app = express();
app.use(cors({
  origin: "https://spywords.com.ge",  // Only allow connections from this domain
  methods: ["GET", "POST"],
  credentials: true,  // Enable cookie usage
}));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: "https://spywords.com.ge",  // Your application's URL
    methods: ["GET", "POST"],
    credentials: true,  // Same as CORS
  },
  transports: ['websocket', 'polling'],  // Fallback for Polling
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ✅ MySQL Connection Pooling
let db;

async function initializeDB() {
  try {
    console.log("Trying to connect to the DB with the following parameters:", {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT,
    });

    // Create a connection pool
    db = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT,
    });

    console.log("✅ MySQL connection successful.");
  } catch (error) {
    console.error("❌ MySQL connection failed:", error);
    process.exit(1); // stop server if DB connection fails
  }
}

// ✅ Token Validation
app.post("/api/verify-token", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    res.status(200).json({ message: "Token is valid", user: decoded });
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// Protected data route
app.get("/api/protected-data", async (req, res) => {
  const token = req.headers["authorization"]?.split(" ")[1];  // Get token from Authorization header

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);  // Verify token
    console.log("Decoded user:", decoded);

    const [rows] = await db.query("SELECT * FROM protected_table WHERE user_id = ?", [decoded.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "No data found for the user" });
    }

    res.status(200).json(rows);  // Send the data back to the frontend
  } catch (err) {
    console.error("❌ Error verifying token:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// 🔄 Room Management
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
    console.log(`🧹 Room deleted: ${roomId}`);
  }
}

// ✅ Registration
app.post("/api/register", async (req, res) => {
  const { nickname, password, email } = req.body;

  if (!nickname || !password || !email) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    console.log(`Trying to register user: ${nickname}`);

    const [existing] = await db.query(
      "SELECT id FROM users WHERE nickname = ? OR email = ?",
      [nickname, email]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: "Nickname or email already exists" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      "INSERT INTO users (nickname, password_hash, email, tarigi) VALUES (?, ?, ?, NOW())",
      [nickname, password_hash, email]
    );

    return res.status(200).json({ message: "Registration successful" });
  } catch (err) {
    console.error("❌ Registration error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ Login
app.post("/api/login", async (req, res) => {
  const { nickname, password } = req.body;

  if (!nickname || !password) {
    return res.status(400).json({ error: "Both fields are required" });
  }

  try {
    const [rows] = await db.query("SELECT id, nickname, password_hash FROM users WHERE nickname = ?", [nickname]);

    if (rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ error: "Invalid password" });
    }

    // JWT generation
    const token = jwt.sign(
      { id: user.id, nickname: user.nickname },
      process.env.JWT_SECRET_KEY,  // Use environment variable for secret key
      { expiresIn: '1h' }  // Token expiration set to 1 hour
    );

    return res.status(200).json({
      message: "Login successful",
      nickname: user.nickname,
      token,  // Return JWT token
    });
  } catch (err) {
    console.error("❌ Login error:", err);
    return res.status(500).json({ error: "Server error" });
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
  console.log("🔌 Connected:", socket.id);

  socket.on("login", async ({ nickname, password }, callback) => {
    try {
      const [rows] = await db.query("SELECT * FROM users WHERE nickname = ?", [
        nickname,
      ]);
      if (rows.length === 0) {
        return callback({
          success: false,
          message: "User not found",
        });
      }

      const match = await bcrypt.compare(password, rows[0].password_hash);
      if (!match)
        return callback({ success: false, message: "Invalid password" });

      callback({ success: true, nickname: rows[0].nickname });
    } catch (err) {
      console.error(err);
      callback({ success: false, message: "Server error" });
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
    if (!rooms[roomId]) return callback("Room not found");

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
