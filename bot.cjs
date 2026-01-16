/**
 * bot.cjs — Elmas Reklam Bot (CommonJS)
 *
 * FIX: users.id yerine users.telegram_id kullanır. (Supabase hatasını çözer)
 * Reklam akışı:
 * 1) "Reklam İzle" -> ads tablosundan bir reklam seçer
 * 2) ad_sessions tablosuna session açar
 * 3) Kullanıcıya Telegram içinde açılan WebApp butonu gönderir (WEB_BASE_URL + WEBAPP_WATCH_PATH + ?sid=...)
 * 4) Ödül verme: Web service (web-server.cjs) /api/ad/complete ile session'ı tamamlayıp ödülü verir.
 *
 * Gerekli ENV:
 * BOT_TOKEN
 * ADMIN_ID
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * WEB_BASE_URL
 * (opsiyonel) WEBAPP_WATCH_PATH  -> default: /webapp/watch.html
 */

const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

require("dotenv").config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEB_BASE_URL = (process.env.WEB_BASE_URL || "").replace(/\/+$/, "");
const WEBAPP_WATCH_PATH = (process.env.WEBAPP_WATCH_PATH || "/webapp/watch.html");

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!WEB_BASE_URL) throw new Error("Missing WEB_BASE_URL (ex: https://elmas-web.onrender.com)");

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --------------------- UI ---------------------
const mainMenu = Markup.keyboard([
  ["🎥 Reklam İzle", "💼 Cüzdan"],
  ["🛒 Market", "👥 Referans"],
  ["🏧 Para Çek", "🔥 VIP"],
]).resize().persistent();

function fmt2(n) {
  const x = Number(n || 0);
  return x.toFixed(2);
}

function nowISO() {
  return new Date().toISOString();
}

function genUUID() {
  // Node 22 supports crypto.randomUUID()
  if (crypto.randomUUID) return crypto.randomUUID();
  // fallback
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16)
  );
}

// --------------------- DB helpers ---------------------
async function ensureUser(ctx) {
  const tg = ctx.from;
  const telegram_id = String(tg.id);

  // users tablosu telegram_id üzerinden çalışır
  // Kolon önerileri:
  // telegram_id (text or bigint UNIQUE)
  // first_name, username
  // balance_tl numeric default 0
  // balance_elmas numeric default 0
  // referral_code text
  // referred_by text (davet eden telegram_id)
  // created_at timestamptz default now()

  const { data: existing, error: selErr } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .maybeSingle();

  if (selErr) throw selErr;

  if (existing) {
    // ufak update (isim değişmiş olabilir)
    await supabase
      .from("users")
      .update({
        first_name: tg.first_name || null,
        username: tg.username || null,
        last_seen_at: nowISO(),
      })
      .eq("telegram_id", telegram_id);
    return existing;
  }

  const referral_code = `ELMAS${telegram_id.slice(-6)}`; // basit kod
  const insertObj = {
    telegram_id,
    first_name: tg.first_name || null,
    username: tg.username || null,
    balance_tl: 0,
    balance_elmas: 0,
    referral_code,
    referred_by: null,
    created_at: nowISO(),
    last_seen_at: nowISO(),
  };

  const { data: ins, error: insErr } = await supabase
    .from("users")
    .insert(insertObj)
    .select("*")
    .single();

  if (insErr) throw insErr;
  return ins;
}

async function getUserByTelegramId(telegram_id) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", String(telegram_id))
    .maybeSingle();
  if (error) throw error;
  return data;
}

// --------------------- Ads flow ---------------------
async function pickAd() {
  // ads tablosu öneri kolonlar:
  // id (uuid/int), title, url (mp4 link), duration_sec int, reward_tl numeric, reward_elmas numeric, is_active bool
  const { data, error } = await supabase
    .from("ads")
    .select("id,title,url,duration_sec,reward_tl,reward_elmas,is_active")
    .eq("is_active", true)
    .limit(20);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const idx = Math.floor(Math.random() * data.length);
  return data[idx];
}

async function createAdSession({ telegram_id, ad }) {
  // ad_sessions tablosu öneri kolonlar:
  // session_id uuid/text PK
  // telegram_id text
  // ad_id uuid/int
  // secret text
  // duration_sec int
  // reward_tl numeric
  // reward_elmas numeric
  // status text default 'created'  (created|started|completed|expired)
  // created_at timestamptz default now()
  // expires_at timestamptz
  const session_id = genUUID();
  const secret = crypto.randomBytes(16).toString("hex");
  const duration_sec = Number(ad.duration_sec || 15);
  const reward_tl = Number(ad.reward_tl || 0);
  const reward_elmas = Number(ad.reward_elmas || 0);

  const expiresAt = new Date(Date.now() + (duration_sec + 180) * 1000).toISOString(); // süre + 3dk buffer

  const payload = {
    session_id,
    telegram_id: String(telegram_id),
    ad_id: ad.id,
    secret,
    duration_sec,
    reward_tl,
    reward_elmas,
    status: "created",
    created_at: nowISO(),
    expires_at: expiresAt,
  };

  const { data, error } = await supabase.from("ad_sessions").insert(payload).select("*").single();
  if (error) throw error;

  return data;
}

function webAppButton(url) {
  // Telegram içinde webview açar (ayrı tarayıcı yerine)
  return Markup.inlineKeyboard([
    Markup.button.webApp("🎬 Reklamı İzle", url),
  ]);
}

// --------------------- Commands / Handlers ---------------------
bot.start(async (ctx) => {
  try {
    await ensureUser(ctx);

    // /start <ref>
    const text = ctx.message?.text || "";
    const parts = text.split(" ");
    if (parts.length >= 2) {
      const ref = parts[1].trim();
      const me = String(ctx.from.id);

      const user = await getUserByTelegramId(me);
      // referred_by boşsa setle
      if (user && !user.referred_by && ref && ref !== me) {
        // ref'i telegram_id olarak kabul ediyoruz (istersen referral_code ile de kurarız)
        await supabase.from("users").update({ referred_by: ref }).eq("telegram_id", me);
      }
    }

    await ctx.reply("✅ Bot çalışıyor. Menü:", mainMenu);
  } catch (e) {
    console.error("START ERR:", e);
    await ctx.reply("❌ Bir hata oldu. Render Logs'a bak.");
  }
});

bot.hears("💼 Cüzdan", async (ctx) => {
  try {
    const u = await ensureUser(ctx);
    const fresh = await getUserByTelegramId(u.telegram_id);

    const tl = fmt2(fresh?.balance_tl);
    const elmas = fmt2(fresh?.balance_elmas);

    await ctx.reply(
      `💼 Cüzdan\n\n💰 Bakiye: ${tl} TL\n💎 Elmas: ${elmas} ELMAS`,
      mainMenu
    );
  } catch (e) {
    console.error("WALLET ERR:", e);
    await ctx.reply("❌ Cüzdan okunamadı.");
  }
});

bot.hears("👥 Referans", async (ctx) => {
  try {
    const u = await ensureUser(ctx);
    const fresh = await getUserByTelegramId(u.telegram_id);

    const myCode = fresh?.referral_code || `ELMAS${String(u.telegram_id).slice(-6)}`;
    const refLink = `https://t.me/${ctx.me}?start=${u.telegram_id}`;

    await ctx.reply(
      `👥 Referans\n\n🔗 Davet linkin:\n${refLink}\n\n🏷 Kod: ${myCode}\n\n✅ Davet ettiğin kişi reklam izlerse %10 pay (web-server tarafında verilecek)`,
      mainMenu
    );
  } catch (e) {
    console.error("REF ERR:", e);
    await ctx.reply("❌ Referans bilgisi alınamadı.");
  }
});

bot.hears("🛒 Market", async (ctx) => {
  await ctx.reply("🛒 Market yakında aktif olacak.", mainMenu);
});

bot.hears("🏧 Para Çek", async (ctx) => {
  await ctx.reply("🏧 IBAN ve tutar akışını birazdan bağlayacağız.", mainMenu);
});

bot.hears("🔥 VIP", async (ctx) => {
  await ctx.reply("🔥 VIP sistemi yakında aktif olacak.", mainMenu);
});

bot.hears("🎥 Reklam İzle", async (ctx) => {
  try {
    const u = await ensureUser(ctx);
    const telegram_id = String(u.telegram_id);

    const ad = await pickAd();
    if (!ad) {
      await ctx.reply("❌ Reklam getirilemedi. Supabase ads tablosunu kontrol et.", mainMenu);
      return;
    }

    const session = await createAdSession({ telegram_id, ad });

    const duration = Number(session.duration_sec || ad.duration_sec || 15);
    const rewardTl = fmt2(session.reward_tl || ad.reward_tl || 0);
    const rewardElmas = fmt2(session.reward_elmas || ad.reward_elmas || 0);

    // Reklam, Telegram WebApp icinde acilir (harici tarayici degil).
    // watch.html sayfasi sid parametresiyle session'i alir, sayaci gosterir,
    // reklam tamamlaninca otomatik odul verir ve Telegram.WebApp.close() ile kapanir.
    const watchPath = WEBAPP_WATCH_PATH.startsWith("/") ? WEBAPP_WATCH_PATH : `/${WEBAPP_WATCH_PATH}`;
    const url = `${WEB_BASE_URL}${watchPath}?sid=${encodeURIComponent(session.session_id)}`;
    await ctx.reply(
      `🎬 ${ad.title || "Reklam"}\n\n⏱ Süre: ${duration} sn\n🎁 Ödül: ${rewardTl} TL + ${rewardElmas} ELMAS\n\n✅ Reklam Telegram icinde acilacak. Reklam bitince odul otomatik yatacak (buton yok).`,
      webAppButton(url)
    );

    await ctx.reply("Menü:", mainMenu);
  } catch (e) {
    console.error("AD ERR:", e);
    await ctx.reply("❌ Reklam oturumu oluşturulamadı. Render Logs'a bak.");
  }
});

// Admin: basit kontrol (istersen büyütürüz)
bot.command("admin", async (ctx) => {
  try {
    const me = String(ctx.from.id);
    if (!ADMIN_ID || me !== ADMIN_ID) return;

    const { count: usersCount } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true });

    const { count: adsCount } = await supabase
      .from("ads")
      .select("*", { count: "exact", head: true });

    await ctx.reply(
      `🛠 Admin Panel\n\n👤 Users: ${usersCount ?? "?"}\n🎥 Ads: ${adsCount ?? "?"}\n\nNot: Google AdSense vb. reklam eklemeyi web panelden yapacağız.`,
      mainMenu
    );
  } catch (e) {
    console.error("ADMIN ERR:", e);
    await ctx.reply("❌ Admin panel hata.");
  }
});

// Catch all errors
bot.catch((err) => {
  console.error("BOT CATCH:", err);
});

// --------------------- Start ---------------------
bot.launch().then(() => console.log("✅ Bot started (polling)"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
