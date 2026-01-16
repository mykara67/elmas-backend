// web-server.cjs (fixed2)
// Serves Telegram WebApp under /webapp and provides rewarded-watch APIs.
//
// Required env on Render (elmas-web):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   BOT_TOKEN   (recommended for Telegram initData verification)

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// ---------- Static WebApp ----------
const ROOT = process.cwd();              // repo root on Render
const WEBAPP_DIR = path.join(ROOT, "webapp");

app.get("/", (req, res) => res.status(200).send("OK"));

app.use("/webapp", express.static(WEBAPP_DIR, {
  extensions: ["html"],
  fallthrough: true,
  maxAge: "0",
}));

app.get(["/webapp", "/webapp/"], (req, res) => {
  res.sendFile(path.join(WEBAPP_DIR, "index.html"));
});

// ---------- Supabase ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "", {
  auth: { persistSession: false },
});

// ---------- Telegram initData verification ----------
const BOT_TOKEN = process.env.BOT_TOKEN || "";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}
function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}
function verifyTelegramInitData(initDataRaw) {
  if (!initDataRaw || typeof initDataRaw !== "string") return { ok: false, reason: "missing_initdata" };
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };

  // data-check-string
  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (k === "hash") continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  // parse user
  let user = null;
  const userJson = params.get("user");
  if (userJson) {
    try { user = JSON.parse(userJson); } catch (e) {}
  }

  if (!BOT_TOKEN) {
    console.warn("⚠️ BOT_TOKEN missing on web service. initData verification skipped.");
    return { ok: true, user, skipped: true };
  }

  const secretKey = sha256(BOT_TOKEN);
  const calc = hmacSha256Hex(secretKey, dataCheckString);

  const ok = crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  return { ok, user, reason: ok ? "ok" : "bad_hash" };
}

function getInitData(req) {
  return (
    req.headers["x-telegram-init-data"] ||
    req.query.initData ||
    (req.body && req.body.initData) ||
    ""
  );
}

async function getOrCreateUser(userObj) {
  const tgId = String(userObj?.id || "");
  if (!tgId) throw new Error("no_tg_user");

  let { data: found, error } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", Number(tgId))
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (found) return found;

  // Create minimal user row for your schema
  const ins = await supabase.from("users").insert({
    telegram_id: Number(tgId),
    username: userObj?.username || null,
    first_name: userObj?.first_name || null,
    tokens: 0,
    balance_tl: 0,
    daily_ads: 0,
  }).select("*").single();

  if (ins.error) throw ins.error;
  return ins.data;
}

// ---------- API: GET /api/ad/next ----------
app.get("/api/ad/next", async (req, res) => {
  try {
    const initData = getInitData(req);
    const v = verifyTelegramInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: "bad_init_data", reason: v.reason });

    const tgUser = v.user;
    if (!tgUser?.id) return res.status(400).json({ ok: false, error: "no_user" });

    // Ensure Supabase configured
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: "missing_supabase_env" });
    }

    // Get an active ad (simple selection: latest active)
    const { data: ad, error: adErr } = await supabase
      .from("ads")
      .select("id,title,url,reward,seconds,is_active")
      .eq("is_active", true)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (adErr) throw adErr;
    if (!ad) return res.json({ ok: true, no_ad: true });

    const requiredSeconds = Number(ad.seconds || 15);

    // Create watch session (uuid id is session token)
    const { data: sess, error: sessErr } = await supabase
      .from("ad_watch_sessions")
      .insert({
        tg_id: String(tgUser.id),
        ad_id: ad.id,
        required_seconds: requiredSeconds,
        paid: false,
      })
      .select("id,ad_id,required_seconds,started_at,paid")
      .single();

    if (sessErr) throw sessErr;

    return res.json({
      ok: true,
      session_id: sess.id,
      ad: {
        id: ad.id,
        title: ad.title,
        url: ad.url,
        seconds: requiredSeconds,
        reward_tl: 0.25,
        reward_elmas: 0.25,
      },
    });
  } catch (e) {
    console.error("❌ /api/ad/next error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- API: POST /api/ad/complete ----------
app.post("/api/ad/complete", async (req, res) => {
  try {
    const initData = getInitData(req);
    const v = verifyTelegramInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: "bad_init_data", reason: v.reason });

    const tgUser = v.user;
    if (!tgUser?.id) return res.status(400).json({ ok: false, error: "no_user" });

    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ ok: false, error: "missing_session_id" });

    // Load session
    const { data: sess, error: sessErr } = await supabase
      .from("ad_watch_sessions")
      .select("*")
      .eq("id", session_id)
      .maybeSingle();
    if (sessErr) throw sessErr;
    if (!sess) return res.status(404).json({ ok: false, error: "session_not_found" });
    if (String(sess.tg_id) !== String(tgUser.id)) return res.status(403).json({ ok: false, error: "session_user_mismatch" });
    if (sess.paid) return res.json({ ok: true, already_paid: true });

    // Time check
    const required = Number(sess.required_seconds || 0);
    const startedAt = sess.started_at ? new Date(sess.started_at).getTime() : 0;
    const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : required;
    if (required > 0 && elapsed + 1 < required) {
      return res.status(400).json({ ok: false, error: "watch_time_not_met", required, elapsed });
    }

    // Update user balances
    const userRow = await getOrCreateUser(tgUser);
    const newTokens = Number(userRow.tokens || 0) + 0.25;
    const newTl = Number(userRow.balance_tl || 0) + 0.25;

    const { error: updErr } = await supabase
      .from("users")
      .update({ tokens: newTokens, balance_tl: newTl })
      .eq("telegram_id", Number(tgUser.id));
    if (updErr) throw updErr;

    // Mark session paid
    const { error: sessUpdErr } = await supabase
      .from("ad_watch_sessions")
      .update({ paid: true, completed_at: new Date().toISOString() })
      .eq("id", session_id);
    if (sessUpdErr) throw sessUpdErr;

    // Best-effort: write ad_views (if your schema matches)
    try {
      await supabase.from("ad_views").insert({
        tg_id: String(tgUser.id),
        ad_id: sess.ad_id,
        seconds: required,
      });
    } catch (_) {}

    return res.json({ ok: true, reward_tl: 0.25, reward_elmas: 0.25 });
  } catch (e) {
    console.error("❌ /api/ad/complete error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// webapp 404 helper
app.use("/webapp", (req, res) => res.status(404).send("Cannot GET " + req.originalUrl));

app.listen(PORT, () => {
  console.log("✅ Web server running on port", PORT);
  console.log("✅ Serving WEBAPP_DIR:", WEBAPP_DIR);
});
