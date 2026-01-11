import express from "express";
import sqlite3 from "sqlite3";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// 📦 SQLite DB
const db = new sqlite3.Database("./db.sqlite");

// 🗄️ TABLO
db.run(`
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  balance REAL DEFAULT 0,
  mining_until INTEGER DEFAULT 0,
  last_claim INTEGER DEFAULT 0,
  last_mine INTEGER DEFAULT 0
)
`);

// ⏱ SABİTLER
const HOUR = 60 * 60 * 1000;
const MINE_INTERVAL = 5000; // 5 saniye
const REWARD_PER_TICK = 0.0005;

// 🧪 ANA TEST
app.get("/", (req, res) => {
  res.send("Elmas Backend çalışıyor");
});

// 📌 STATUS — mining aktif mi?
app.get("/status/:userId", (req, res) => {
  const userId = req.params.userId;
  const now = Date.now();

  db.get(
    "SELECT * FROM users WHERE user_id = ?",
    [userId],
    (err, user) => {
      if (!user || user.mining_until < now) {
        return res.json({
          canMine: false,
          needAd: true,
          remaining: 0
        });
      }

      return res.json({
        canMine: true,
        needAd: false,
        remaining: user.mining_until - now
      });
    }
  );
});

// 🎯 CLAIM — SAATTE 1 (reklamdan sonra)
app.post("/claim", (req, res) => {
  const { userId } = req.body;
  const now = Date.now();

  db.get(
    "SELECT last_claim FROM users WHERE user_id = ?",
    [userId],
    (err, user) => {
      if (user && now - user.last_claim < HOUR) {
        return res.status(403).json({
          error: "Claim zamanı gelmedi",
          remaining: HOUR - (now - user.last_claim)
        });
      }

      const miningUntil = now + HOUR;

      db.run(
        `INSERT INTO users (user_id, mining_until, last_claim)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
         mining_until = ?,
         last_claim = ?`,
        [userId, miningUntil, now, miningUntil, now],
        () => {
          res.json({
            success: true,
            miningUntil
          });
        }
      );
    }
  );
});

// ⛏️ MINE — süre + anti-spam korumalı
app.post("/mine", (req, res) => {
  const { userId } = re
