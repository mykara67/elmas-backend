const sqlite3 = require("sqlite3").verbose()
const db = new sqlite3.Database("./db.sqlite")

db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  elmas REAL DEFAULT 0,
  bakiye REAL DEFAULT 0,
  gunluk_reklam INTEGER DEFAULT 10,
  vip INTEGER DEFAULT 0,
  referans INTEGER DEFAULT 0
)
`)

const express = require("express");
const sqlite3 = require("sqlite3");
const cors = require("cors");

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

const HOUR = 60 * 60 * 1000;
const REWARD_PER_TICK = 0.0005;

// STATUS
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

      res.json({
        canMine: true,
        needAd: false,
        remaining: user.mining_until - now
      });
    }
  );
});

// CLAIM
app.post("/claim", (req, res) => {
  const { userId } = req.body;
  const now = Date.now();
  const miningUntil = now + HOUR;

  db.run(
    `
    INSERT INTO users (user_id, mining_until, last_claim)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      mining_until = ?,
      last_claim = ?
    `,
    [userId, miningUntil, now, miningUntil, now],
    () => {
      res.json({ success: true, miningUntil });
    }
  );
});

// MINE
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
          error: "Süre doldu, reklam gerekli"
        });
      }

      db.run(
        "UPDATE users SET balance = balance + ? WHERE user_id = ?",
        [REWARD_PER_TICK, userId],
        () => {
          res.json({ success: true, added: REWARD_PER_TICK });
        }
      );
    }
  );
});

// BALANCE
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Backend çalışıyor (${PORT})`);
});