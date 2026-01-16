// bot.cjs (CommonJS) - Telegram Worker (Telegraf)
// - Reklam izle: Telegram WebApp icinde acilir (web_app button)
// - Odul: sadece WebApp sayfasi sureyi doldurup sunucuya onay gonderirse verilir

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '').trim();
const WEB_BASE_URL = String(process.env.WEB_BASE_URL || '').replace(/\/$/, '');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN missing in env');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in env');
}
if (!WEB_BASE_URL) {
  console.warn('⚠️ WEB_BASE_URL is empty. Reklam WebApp linkleri calismaz.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const bot = new Telegraf(BOT_TOKEN);

function mainMenuKeyboard() {
  // Alt sabit menu (reply keyboard)
  return Markup.keyboard([
    ['🎥 Reklam İzle', '💼 Cüzdan'],
    ['🛒 Market', '👥 Referans'],
    ['🏧 Para Çek', '🔥 VIP'],
  ])
    .resize()
    .persistent();
}

async function upsertUser(tgUser) {
  const userId = String(tgUser.id);
  const username = tgUser.username || null;
  const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');

  const { data: existing, error: selErr } = await supabase
    .from('users')
    .select('id,balance_tl,balance_elmas,referrer_id')
    .eq('id', userId)
    .maybeSingle();
  if (selErr) throw selErr;

  if (!existing) {
    const { error: insErr } = await supabase.from('users').insert({
      id: userId,
      username,
      full_name: fullName,
      balance_tl: 0,
      balance_elmas: 0,
    });
    if (insErr) throw insErr;
  } else {
    // keep it light; only update optional fields
    await supabase
      .from('users')
      .update({ username, full_name: fullName })
      .eq('id', userId);
  }
  return userId;
}

async function getActiveAd() {
  const { data, error } = await supabase
    .from('ads')
    .select('id,title,url,seconds,reward_tl,reward_elmas,is_active')
    .eq('is_active', true)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createAdSession({ userId, ad }) {
  const payload = {
    user_id: userId,
    ad_id: ad.id,
    seconds: ad.seconds || 15,
    reward_tl: ad.reward_tl || 0,
    reward_elmas: ad.reward_elmas || 0,
    status: 'created',
  };

  const { data, error } = await supabase
    .from('ad_sessions')
    .insert(payload)
    .select('id,user_id,ad_id,seconds,reward_tl,reward_elmas,status,created_at,completed_at,paid_at')
    .single();
  if (error) throw error;
  return data;
}

async function creditUserForSession(sessionId) {
  // Odul sadece: session completed_at dolmus ve paid_at bos ise
  const { data: s, error: sErr } = await supabase
    .from('ad_sessions')
    .select('id,user_id,seconds,reward_tl,reward_elmas,status,created_at,completed_at,paid_at,ad_id')
    .eq('id', sessionId)
    .single();
  if (sErr) throw sErr;

  if (!s.completed_at || s.status !== 'completed') {
    return { ok: false, reason: 'not_completed' };
  }
  if (s.paid_at) {
    return { ok: false, reason: 'already_paid' };
  }

  // credit balances
  const { data: u, error: uErr } = await supabase
    .from('users')
    .select('id,balance_tl,balance_elmas,referrer_id')
    .eq('id', s.user_id)
    .single();
  if (uErr) throw uErr;

  const addTl = Number(s.reward_tl || 0);
  const addElmas = Number(s.reward_elmas || 0);

  const newTl = Number(u.balance_tl || 0) + addTl;
  const newElmas = Number(u.balance_elmas || 0) + addElmas;

  const { error: upErr } = await supabase
    .from('users')
    .update({ balance_tl: newTl, balance_elmas: newElmas })
    .eq('id', u.id);
  if (upErr) throw upErr;

  // Referral: %10
  if (u.referrer_id) {
    const refAddTl = addTl * 0.1;
    const refAddElmas = addElmas * 0.1;
    const { data: r, error: rErr } = await supabase
      .from('users')
      .select('id,balance_tl,balance_elmas')
      .eq('id', u.referrer_id)
      .maybeSingle();
    if (!rErr && r) {
      await supabase
        .from('users')
        .update({
          balance_tl: Number(r.balance_tl || 0) + refAddTl,
          balance_elmas: Number(r.balance_elmas || 0) + refAddElmas,
        })
        .eq('id', r.id);
    }
  }

  // mark paid
  const { error: pErr } = await supabase
    .from('ad_sessions')
    .update({ paid_at: new Date().toISOString(), status: 'paid' })
    .eq('id', s.id);
  if (pErr) throw pErr;

  return { ok: true, addTl, addElmas, userId: s.user_id };
}

bot.start(async (ctx) => {
  await upsertUser(ctx.from);
  await ctx.reply('✅ Bot çalışıyor. Menü:', mainMenuKeyboard());
});

bot.hears('📋 Menü', async (ctx) => {
  await ctx.reply('✅ Menü:', mainMenuKeyboard());
});

bot.hears('🎥 Reklam İzle', async (ctx) => {
  const userId = await upsertUser(ctx.from);

  const ad = await getActiveAd();
  if (!ad) {
    return ctx.reply('❌ Reklam getirilemedi. Supabase ads tablosunu kontrol et.', mainMenuKeyboard());
  }

  const session = await createAdSession({ userId, ad });
  const url = `${WEB_BASE_URL}/ad/${session.id}`;

  // Telegram WebApp button => Telegram icinde acilir
  const kb = Markup.inlineKeyboard([
    [Markup.button.webApp('▶️ Reklamı Aç (Telegram)', url)],
  ]);

  await ctx.reply(
    `✅ Reklam hazır.\n\n🕒 Süre: ${session.seconds} sn\n🎁 Ödül: ${Number(session.reward_tl || 0).toFixed(2)} TL + ${Number(session.reward_elmas || 0).toFixed(2)} ELMAS\n\n⚠️ Ödül sadece sayaç bitip sayfa otomatik onay gönderince verilir.`,
    kb
  );
});

bot.hears('💼 Cüzdan', async (ctx) => {
  const userId = await upsertUser(ctx.from);
  const { data: u, error } = await supabase
    .from('users')
    .select('balance_tl,balance_elmas')
    .eq('id', userId)
    .single();
  if (error) throw error;

  await ctx.reply(
    `💼 Cüzdan\n\n💸 TL: ${Number(u.balance_tl || 0).toFixed(2)}\n💎 ELMAS: ${Number(u.balance_elmas || 0).toFixed(2)}`,
    mainMenuKeyboard()
  );
});

bot.hears('🛒 Market', async (ctx) => {
  await ctx.reply('🛒 Market yakında. (Elmas↔TL / USDT entegrasyonu adım adım eklenecek)', mainMenuKeyboard());
});

bot.hears('👥 Referans', async (ctx) => {
  const userId = await upsertUser(ctx.from);
  const link = `https://t.me/${ctx.me}?start=ref_${userId}`;
  await ctx.reply(
    `👥 Referans\n\nDavet linkin:\n${link}\n\nDavet ettiklerinin reklam kazancının %10'u sana yansır.`,
    mainMenuKeyboard()
  );
});

bot.hears('🏧 Para Çek', async (ctx) => {
  await ctx.reply('🏧 Para çekme yakında (IBAN + admin onay).', mainMenuKeyboard());
});

bot.hears('🔥 VIP', async (ctx) => {
  await ctx.reply('🔥 VIP yakında.', mainMenuKeyboard());
});

// Telegram WebApp -> bot'a veri gonderir (web_app_data)
bot.on('message', async (ctx, next) => {
  const wad = ctx.message && ctx.message.web_app_data;
  if (!wad) return next();

  let payload;
  try {
    payload = JSON.parse(wad.data);
  } catch {
    return ctx.reply('❌ WebApp verisi okunamadı.', mainMenuKeyboard());
  }

  if (payload && payload.type === 'ad_complete' && payload.sessionId) {
    try {
      const res = await creditUserForSession(payload.sessionId);
      if (res.ok) {
        return ctx.reply(
          `✅ Ödül yüklendi!\n+${res.addTl.toFixed(2)} TL\n+${res.addElmas.toFixed(2)} ELMAS`,
          mainMenuKeyboard()
        );
      }
      if (res.reason === 'already_paid') {
        return ctx.reply('ℹ️ Bu reklam için ödül zaten verildi.', mainMenuKeyboard());
      }
      return ctx.reply('❌ Ödül verilemedi. Süre dolmamış olabilir.', mainMenuKeyboard());
    } catch (e) {
      console.error('web_app_data credit error:', e);
      return ctx.reply('❌ Ödül verilemedi. Daha sonra tekrar dene.', mainMenuKeyboard());
    }
  }

  return ctx.reply('ℹ️ WebApp mesajı alındı.', mainMenuKeyboard());
});

bot.catch((err) => {
  console.error('BOT ERROR:', err);
});

// Worker: long polling
bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
