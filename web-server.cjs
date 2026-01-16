// web-server.cjs (debug+fix)
// - Safer Telegram initData verification (no timingSafeEqual length crash)
// - More detailed logs for /api/ad/next and /api/ad/complete

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// ---------- Static WebApp ----------
const ROOT = process.cwd();
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

// Placeholder/bozuk reklam linkleri varken odeme yapmayalim.
function isValidAdUrl(url) {
  if (!url || typeof url !== "string") return false;
  const u = url.trim();
  if (!u) return false;
  // placeholder/ornek linkler
  if (/SENIN_/i.test(u)) return false;
  if (u === "https://example.com") return false;
  // temel format
  if (!/^https?:\/\//i.test(u)) return false;
  return true;
}

// users tablosunda kolon adi token mi tokens mi bilinmedigi icin fallback.
async function incrementUserBalances(tg_id, tlInc, elmasInc) {
  // 1) once tokens kolonu deneyelim
  let r = await supabase
    .from("users")
    .update({
      balance_tl: supabase.rpc ? undefined : undefined,
    })
    .eq("tg_id", tg_id);

  // supabase-js update ile atomik arttirma icin rpc kullanmak en dogrusu ama
  // burada pratik cozum: once mevcut degerleri cekip sonra update.
  const { data: u, error: uErr } = await supabase
    .from("users")
    .select("tg_id,balance_tl,tokens,token")
    .eq("tg_id", tg_id)
    .maybeSingle();
  if (uErr) throw uErr;
  const curTl = Number(u?.balance_tl || 0);
  const hasTokens = Object.prototype.hasOwnProperty.call(u || {}, "tokens");
  const hasToken = Object.prototype.hasOwnProperty.call(u || {}, "token");
  const curElmas = hasTokens ? Number(u?.tokens || 0) : hasToken ? Number(u?.token || 0) : 0;

  const patch = { balance_tl: +(curTl + tlInc).toFixed(2) };
  if (hasTokens) patch.tokens = +(curElmas + elmasInc).toFixed(2);
  else if (hasToken) patch.token = +(curElmas + elmasInc).toFixed(2);

  const { error: upErr } = await supabase.from("users").update(patch).eq("tg_id", tg_id);
  if (upErr) throw upErr;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}
function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}
function safeTimingEqualHex(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string") return false;
  if (aHex.length !== bHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(aHex), Buffer.from(bHex));
  } catch (_) {
    return false;
  }
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

  const ok = safeTimingEqualHex(calc, hash);
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

// ---------- Helpers ----------
function short(s, n=90){ if(!s) return ""; s=String(s); return s.length>n? (s.slice(0,n)+"…") : s; }

// ---------- API: GET /api/ad/next ----------
app.get("/api/ad/next", async (req, res) => {
  const initData = getInitData(req);
  const v = verifyTelegramInitData(initData);

  console.log("➡️ /api/ad/next", { ok: v.ok, reason: v.reason, initDataLen: (initData||"").length });

  if (!v.ok) return res.status(401).json({ ok: false, error: "bad_init_data", reason: v.reason });

  const tgUser = v.user;
  if (!tgUser?.id) return res.status(400).json({ ok: false, error: "no_user" });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ missing supabase env", { hasUrl: !!SUPABASE_URL, hasKey: !!SUPABASE_SERVICE_ROLE_KEY });
    return res.status(500).json({ ok: false, error: "missing_supabase_env" });
  }

  try {
    const { data: ad, error: adErr } = await supabase
      .from("ads")
      .select("id,title,url,reward,seconds,is_active")
      .eq("is_active", true)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (adErr) {
      console.error("❌ ads select error:", adErr);
      return res.status(500).json({ ok: false, error: "ads_select_error", details: adErr.message || String(adErr) });
    }

    if (!ad || !isValidAdUrl(ad.url)) {
      console.log("ℹ️ no active/valid ad");
      return res.json({ ok: true, no_ad: true });
    }

    const requiredSeconds = Number(ad.seconds || 15);

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

    if (sessErr) {
      console.error("❌ ad_watch_sessions insert error:", sessErr);
      return res.status(500).json({ ok: false, error: "session_insert_error", details: sessErr.message || String(sessErr) });
    }

    console.log("✅ session created", { session_id: sess.id, ad_id: ad.id, requiredSeconds });

    return res.json({
      ok: true,
      session_id: sess.id,
      ad: {
        id: ad.id,
        title: ad.title,
        url: ad.url,
        seconds: requiredSeconds,
        reward_tl: Number(ad.reward || 0),
        reward_elmas: Number(ad.reward || 0),
      },
    });
  } catch (e) {
    console.error("❌ /api/ad/next server_error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error", details: e?.message || String(e) });
  }
});

// ---------- API: POST /api/ad/complete ----------
app.post("/api/ad/complete", async (req, res) => {
  const initData = getInitData(req);
  const v = verifyTelegramInitData(initData);

  console.log("➡️ /api/ad/complete", { ok: v.ok, reason: v.reason, initDataLen: (initData||"").length });

  if (!v.ok) return res.status(401).json({ ok: false, error: "bad_init_data", reason: v.reason });

  const tgUser = v.user;
  if (!tgUser?.id) return res.status(400).json({ ok: false, error: "no_user" });

  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ ok: false, error: "missing_session_id" });

  try {
    const { data: sess, error: sessErr } = await supabase
      .from("ad_watch_sessions")
      .select("*")
      .eq("id", session_id)
      .maybeSingle();
    if (sessErr) {
      console.error("❌ session select error:", sessErr);
      return res.status(500).json({ ok: false, error: "session_select_error", details: sessErr.message || String(sessErr) });
    }
    if (!sess) return res.status(404).json({ ok: false, error: "session_not_found" });
    if (String(sess.tg_id) !== String(tgUser.id)) return res.status(403).json({ ok: false, error: "session_user_mismatch" });
    if (sess.paid) return res.json({ ok: true, already_paid: true });

    const required = Number(sess.required_seconds || 0);
    const startedAt = sess.started_at ? new Date(sess.started_at).getTime() : 0;
    const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : required;

    if (required > 0 && elapsed + 1 < required) {
      return res.status(400).json({ ok: false, error: "watch_time_not_met", required, elapsed });
    }

    // Odeme miktarini reklamin kendisinden al (reklam yoksa odeme YOK)
    const tgIdNum = Number(tgUser.id);

    const { data: adRow, error: adErr } = await supabase
      .from("ads")
      .select("id,url,reward,is_active")
      .eq("id", sess.ad_id)
      .maybeSingle();

    if (adErr) {
      console.error("❌ ad select error:", adErr);
      return res.status(500).json({ ok: false, error: "ad_select_error", details: adErr.message || String(adErr) });
    }

    if (!adRow || adRow.is_active !== true || !isValidAdUrl(adRow.url)) {
      return res.status(400).json({ ok: false, error: "no_ad" });
    }

    const reward_tl = Number(adRow.reward || 0);
    const reward_elmas = reward_tl;
    if (!(reward_tl > 0)) {
      return res.status(400).json({ ok: false, error: "invalid_reward" });
    }

    // tokens = ELMAS (senin bot mantigina gore)
    await incrementUserBalances(tgIdNum, reward_elmas, reward_tl);

    const { error: sessUpdErr } = await supabase
      .from("ad_watch_sessions")
      .update({ paid: true, completed_at: new Date().toISOString() })
      .eq("id", session_id);
    if (sessUpdErr) {
      console.error("❌ session update error:", sessUpdErr);
      return res.status(500).json({ ok: false, error: "session_update_error", details: sessUpdErr.message || String(sessUpdErr) });
    }

    console.log("✅ paid session", { session_id, tg_id: tgUser.id, reward_tl, reward_elmas });

    return res.json({ ok: true, reward_tl, reward_elmas });
  } catch (e) {
    console.error("❌ /api/ad/complete server_error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error", details: e?.message || String(e) });
  }
});

app.use("/webapp", (req, res) => res.status(404).send("Cannot GET " + req.originalUrl));

app.listen(PORT, () => {
  console.log("✅ Web server running on port", PORT);
  console.log("✅ Serving WEBAPP DIR:", WEBAPP_DIR);
});
