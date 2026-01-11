const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ⏱ SABİTLER
const HOUR = 60 * 60 * 1000;
const REWARD_PER_TICK = 0.0005;

// 📌 STATUS
app.get("/status/:userId", async (req, res) => {
  const userId = req.params.userId;
  const now = Date.now();

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

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
});

// 🎯 CLAIM
app.post("/claim", async (req, res) => {
  const { userId } = req.body;
  const now = Date.now();
  const miningUntil = now + HOUR;

  await supabase.from("users").upsert({
    user_id: userId,
    mining_until: miningUntil,
    last_claim: now
  });

  res.json({ success: true, miningUntil });
});

// ⛏ MINE
app.post("/mine", async (req, res) => {
  const { userId } = req.body;
  const now = Date.now();

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!user || user.mining_until < now) {
    return res.status(403).json({
      error: "Süre doldu, claim gerekli"
    });
  }

  await supabase
    .from("users")
    .update({
      balance: user.balance + REWARD_PER_TICK
    })
    .eq("user_id", userId);

  res.json({ success: true, added: REWARD_PER_TICK });
});

// 💰 BALANCE
app.get("/balance/:userId", async (req, res) => {
  const { userId } = req.params;

  const { data } = await supabase
    .from("users")
    .select("balance")
    .eq("user_id", userId)
    .single();

  res.json({ balance: data?.balance || 0 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Backend çalışıyor (${PORT})`)
);
