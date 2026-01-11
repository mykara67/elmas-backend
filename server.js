import express from "express";
import sqlite3 from "sqlite3";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database("./db.sqlite");

db.run(`
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  balance REAL DEFAULT 0,
  mining_until INTEGER DEFAULT 0,
  last_claim INTEGER DEFAULT 0
)
`);

// ⏱ SABİTLER
const HOUR = 60 * 60 * 1000;
const REWARD_PER_TICK = 0.0005; // her mine çağrısı

// 📌 STATUS — mining var mı? reklam gerekli mi?
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

// 🎯 CLAIM — reklam izlendikten sonra ÇAĞRILIR
app.post("/claim", (req, res) => {
  const { userId } = req.body;
  const now = Date.now();

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
});

// ⛏ MINE — SADECE CLAIM + SÜRE VARSA ÇALIŞIR
app.post("/mine", (req, res) => {
  const { userId } = req.body;
  const now = Date.now();

  db.get(
    "SELECT * FROM users WHERE user_id = ?",
    [userId],
    (err, user) => {
      if (!user) {
        return res.status(403).json({ error: "User yok" });
      }

      if (user.mining_until < now) {
        return res.status(403).json({
          error: "Süre doldu, reklam + claim gerekli"
        });
      }

      db.run(
        "UPDATE users SET balance = balance + ? WHERE user_id = ?",
        [REWARD_PER_TICK, userId],
        () => {
          res.json({
            success: true,
            added: REWARD_PER_TICK
          });
        }
      );
    }
  );
});

// 💰 BALANCE — bakiye sorgu
app.get("/balance/:userId", (req, res) => {
  const userId = req.params.userId;

  db.get(
    "SELECT balance FROM users WHERE user_id = ?",
    [userId],
    (err, row) => {
      res.json({ balance: row ? row.balance : 0 });
    }
  );
});

app.listen(3000, () => {
  console.log("✅ Backend çalışıyor (3000)");
});
