const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log("❌ SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY eksik!");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Webapp dizini
const WEBAPP_DIR = path.join(process.cwd(), "webapp");
if (fs.existsSync(WEBAPP_DIR)) {
  app.use(express.static(WEBAPP_DIR));
  console.log("✅ Serving WEBAPP DIR:", WEBAPP_DIR);
} else {
  console.log("⚠️ WEBAPP klasörü bulunamadı:", WEBAPP_DIR);
}

// --------------------
// Helpers
// --------------------
function isValidVideoUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase().trim();
  // gerçek reklam video olsun: mp4/webm/mov/m3u8 gibi
  return (
    u.startsWith("http://") ||
    u.startsWith("https://")
  ) && (
    u.endsWith(".mp4") ||
    u.endsWith(".webm") ||
    u.endsWith(".mov") ||
    u.endsWith(".m3u8")
  );
}

async function detectUserTokenColumn() {
  // users.token mi users.tokens mu var kontrol edelim
  // Supabase postgrest: select ile kolon var mı bakıyoruz
  // token var mı:
  let hasToken = false;
  let hasTokens = false;

  try {
    const { error: e1 } = await supabase.from("users").select("token").limit(1);
    if (!e1) hasToken = true;
  } catch (err) {}

  try {
    const { error: e2 } = await supabase.from("users").select("tokens").limit(1);
    if (!e2) hasTokens = true;
  } catch (err) {}

  if (hasTokens) return "tokens";
  if (hasToken) return "token";
  return null;
}

async function addRewardToUser(tg_id, tlReward, elmasReward) {
  const col = await detectUserTokenColumn();

  // users kaydı var mı?
  const { data: u, error: uErr } = await supabase
    .from("users")
    .select("*")
    .eq("tg_id", tg_id)
    .maybeSingle();

  if (uErr) {
    console.log("❌ users_select_error:", uErr);
    return { ok: false, reason: "users_select_error", error: uErr };
  }

  // yoksa oluştur
  if (!u) {
    const insertPayload = {
      tg_id,
      balance_tl: Number(tlReward || 0),
    };
    if (col) insertPayload[col] = Number(elmasReward || 0);

    const { error: insErr } = await supabase.from("users").insert(insertPayload);
    if (insErr) {
      console.log("❌ users_insert_error:", insErr);
      return { ok: false, reason: "users_insert_error", error: insErr };
    }
    return { ok: true, created: true };
  }

  // varsa güncelle
  const newBalance = Number(u.balance_tl || 0) + Number(tlReward || 0);

  const updatePayload = {
    balance_tl: newBalance,
  };

  if (col) {
    updatePayload[col] = Number(u[col] || 0) + Number(elmasReward || 0);
  }

  const { error: upErr } = await supabase
    .from("users")
    .update(updatePayload)
    .eq("tg_id", tg_id);

  if (upErr) {
    console.log("❌ users_update_error:", upErr);
    return { ok: false, reason: "users_update_error", error: upErr };
  }

  return { ok: true, created: false };
}

// --------------------
// AD NEXT: reklam getir + session oluştur
// --------------------
app.post("/api/ad/next", async (req, res) => {
  try {
    const { tg_id } = req.body || {};

    if (!tg_id) {
      return res.json({ ok: false, reason: "missing_tg_id" });
    }

    // aktif reklam çek
    const { data: ads, error: adErr } = await supabase
      .from("ads")
      .select("*")
      .eq("is_active", true)
      .order("id", { ascending: true })
      .limit(10);

    if (adErr) {
      console.log("❌ ads_select_error:", adErr);
      return res.json({ ok: false, reason: "ads_select_error" });
    }

    if (!ads || ads.length === 0) {
      return res.json({ ok: false, reason: "no_ads" });
    }

    // gerçek video url olan reklamı seç
    const ad = ads.find((x) => isValidVideoUrl(x.url));

    if (!ad) {
      // url mp4 değilse ödül olmasın
      return res.json({ ok: false, reason: "no_real_video_ad" });
    }

    const requiredSeconds = Number(ad.seconds || 10);
    const sessionId = crypto.randomUUID();

    // session oluştur
    const { error: sesErr } = await supabase.from("ad_watch_sessions").insert({
      session_id: sessionId,
      tg_id,
      ad_id: ad.id,
      required_seconds: requiredSeconds,
      started_at: new Date().toISOString(),
      is_paid: false,
    });

    if (sesErr) {
      console.log("❌ session_insert_error:", sesErr);
      return res.json({ ok: false, reason: "session_insert_error" });
    }

    return res.json({
      ok: true,
      session_id: sessionId,
      ad: {
        id: ad.id,
        title: ad.title,
        url: ad.url,
        seconds: requiredSeconds,
        reward_tl: Number(ad.reward_tl || 0),
        reward_token: Number(ad.reward_token || 0),
        text: ad.text || null,
      },
    });
  } catch (e) {
    console.log("❌ /api/ad/next crash:", e);
    return res.json({ ok: false, reason: "server_crash" });
  }
});

// --------------------
// AD COMPLETE: sayaç bitince ödeme
// --------------------
app.post("/api/ad/complete", async (req, res) => {
  try {
    const { session_id, tg_id } = req.body || {};

    if (!session_id || !tg_id) {
      return res.json({ ok: false, reason: "missing_params" });
    }

    // session çek
    const { data: s, error: sErr } = await supabase
      .from("ad_watch_sessions")
      .select("*")
      .eq("session_id", session_id)
      .maybeSingle();

    if (sErr || !s) {
      console.log("❌ session_select_error:", sErr);
      return res.json({ ok: false, reason: "session_not_found" });
    }

    if (s.is_paid) {
      return res.json({ ok: true, already_paid: true });
    }

    // doğru kullanıcı mı
    if (String(s.tg_id) !== String(tg_id)) {
      return res.json({ ok: false, reason: "session_user_mismatch" });
    }

    // süre kontrolü
    const startedAt = new Date(s.started_at).getTime();
    const now = Date.now();
    const requiredMs = Number(s.required_seconds || 10) * 1000;

    if (!startedAt || isNaN(startedAt)) {
      return res.json({ ok: false, reason: "bad_started_at" });
    }

    if (now - startedAt < requiredMs) {
      return res.json({ ok: false, reason: "time_not_completed" });
    }

    // reklam çek
    const { data: ad, error: adErr } = await supabase
      .from("ads")
      .select("*")
      .eq("id", s.ad_id)
      .maybeSingle();

    if (adErr || !ad) {
      return res.json({ ok: false, reason: "ad_not_found" });
    }

    // güvenlik: gerçek video url değilse ödeme yok
    if (!isValidVideoUrl(ad.url)) {
      return res.json({ ok: false, reason: "no_real_ad_url" });
    }

    const tlReward = Number(ad.reward_tl || 0);
    const elmasReward = Number(ad.reward_token || 0);

    // kullanıcıya ödül ekle
    const rewardRes = await addRewardToUser(tg_id, tlReward, elmasReward);
    if (!rewardRes.ok) {
      return res.json({ ok: false, reason: rewardRes.reason });
    }

    // session paid yap
    const { error: paidErr } = await supabase
      .from("ad_watch_sessions")
      .update({
        is_paid: true,
        paid_at: new Date().toISOString(),
      })
      .eq("session_id", session_id);

    if (paidErr) {
      console.log("❌ paid_update_error:", paidErr);
      return res.json({ ok: false, reason: "paid_update_error" });
    }

    return res.json({ ok: true, paid: true, tlReward, elmasReward });
  } catch (e) {
    console.log("❌ /api/ad/complete crash:", e);
    return res.json({ ok: false, reason: "server_crash" });
  }
});

// health
app.get("/health", (req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log("✅ Web server running on port", PORT);
});
