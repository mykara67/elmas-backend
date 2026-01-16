const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const WEB_BASE_URL = process.env.WEB_BASE_URL || 'https://elmas-web.onrender.com';

/**
 * =========================
 * ENV CHECK
 * =========================
 */
const REQUIRED_ENVS = [
  'BOT_TOKEN',
  'ADMIN_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`❌ Missing env: ${key}`);
    process.exit(1);
  }
}

const ADMIN_ID = String(process.env.ADMIN_ID);

/**
 * =========================
 * SUPABASE
 * =========================
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * =========================
 * HELPERS
 * =========================
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mainMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🎥 Reklam İzle', 'watch_ad')],
  ]);

function safeJsonParse(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

async function upsertUser(tgId) {
  const { data: existing, error: e1 } = await supabase
    .from('users')
    .select('telegram_id,balance_tl,pending_action,pending_data')
    .eq('telegram_id', tgId)
    .maybeSingle();

  if (e1) throw e1;
  if (existing) return existing;

  const { data: created, error: e2 } = await supabase
    .from('users')
    .insert([{ telegram_id: tgId, balance_tl: 0, pending_action: null, pending_data: null }])
    .select('telegram_id,balance_tl,pending_action,pending_data')
    .single();

  if (e2) throw e2;
  return created;
}

async function setPending(tgId, action, dataObj) {
  const { error } = await supabase
    .from('users')
    .update({
      pending_action: action,
      pending_data: dataObj ? dataObj : null,
    })
    .eq('telegram_id', tgId);

  if (error) throw error;
}

async function addBalance(tgId, amount) {
  const { data: u, error: e1 } = await supabase
    .from('users')
    .select('balance_tl')
    .eq('telegram_id', tgId)
    .single();

  if (e1) throw e1;

  const newBal = Number(u.balance_tl || 0) + Number(amount || 0);

  const { error: e2 } = await supabase
    .from('users')
    .update({ balance_tl: newBal })
    .eq('telegram_id', tgId);

  if (e2) throw e2;

  return newBal;
}

async function pickActiveAd() {
  const { data, error } = await supabase
    .from('ads')
    .select('id,title,text,url,reward,is_active,seconds')
    .eq('is_active', true)
    .limit(20);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const idx = Math.floor(Math.random() * data.length);
  return data[idx];
}

/**
 * =========================
 * BOT (async bootstrap)
 * =========================
 */
(async () => {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  // Render + webhook kalıntılarını temizlemek iyi pratik
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.log('ℹ️ deleteWebhook skipped:', e?.message || e);
  }

  bot.start(async (ctx) => {
    try {
      await upsertUser(String(ctx.from.id));
      await ctx.reply('✅ Bot çalışıyor. Menü:', mainMenu());
    } catch (err) {
      console.error(err);
      await ctx.reply('❌ Bir hata oluştu. (Supabase tablolarını kontrol et)');
    }
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Menü:', mainMenu());
  });

  // DEBUG: Reply-keyboard / yazıdan gelen metni logla (menü butonları metin gönderir)
  bot.on('text', (ctx, next) => {
    try {
      console.log('TEXT_IN:', JSON.stringify(ctx.message.text));
    } catch {}
    return next();
  });

  // MENÜ: Reply keyboard / yazı ile gelen seçenekleri yakala (emoji farklarına dayanıklı)
  bot.hears(/cüzdan/i, async (ctx) => {
    try {
      const tgId = String(ctx.from.id);
      const u = await upsertUser(tgId);
      const bal = Number(u.balance_tl || 0);
      return ctx.reply(`💼 Cüzdan\n\n💰 Bakiye: ${bal.toFixed(2)} TL`, mainMenu());
    } catch (err) {
      console.error(err);
      return ctx.reply('❌ Cüzdan alınamadı.', mainMenu());
    }
  });

  bot.hears(/market/i, async (ctx) => {
    return ctx.reply('🛒 Market yakında aktif olacak.', mainMenu());
  });

  bot.hears(/referans/i, async (ctx) => {
    try {
      const tgId = String(ctx.from.id);
      const u = await upsertUser(tgId);
      const code = u.ref_code || 'Yok';
      return ctx.reply(`👥 Referans\n\n🔗 Kodun: ${code}`, mainMenu());
    } catch (err) {
      console.error(err);
      return ctx.reply('❌ Referans bilgisi alınamadı.', mainMenu());
    }
  });

  bot.hears(/para\s*çek/i, async (ctx) => {
    return ctx.reply('💸 Para Çek\n\nIBAN ve tutar akışını birazdan bağlayacağız.', mainMenu());
  });

  bot.hears(/vip/i, async (ctx) => {
    return ctx.reply('🔥 VIP\n\nVIP sistemi yakında aktif olacak.', mainMenu());
  });


  bot.command('balance', async (ctx) => {
    try {
      const tgId = String(ctx.from.id);
      const u = await upsertUser(tgId);
      await ctx.reply(`💰 Bakiye: ${Number(u.balance_tl || 0).toFixed(2)} TL`);
    } catch (err) {
      console.error(err);
      await ctx.reply('❌ Bakiye okunamadı.');
    }
  });

  bot.command('admin', async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return ctx.reply('⛔ Yetkisiz.');
    await ctx.reply('👑 Admin paneli (şimdilik boş).');
  });

  /**
   * =========================
   * 5. ADIM: REKLAM SAYAÇ + ÖDEME
   * =========================
   */

  // 1) Menüden "🎥 Reklam İzle"
  bot.action('watch_ad', async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const tgId = String(ctx.from.id);
      await upsertUser(tgId);

      const ad = await pickActiveAd();
      console.log(`🎥 watch_ad requested by ${tgId} -> ${ad ? 'ad ' + ad.id : 'no ad'}`);

      if (!ad) {
        return ctx.reply('📭 Şu an aktif reklam yok. Sonra tekrar dene.', mainMenu());
      }

      const seconds = Math.max(10, Number(ad.seconds || 10));
      const reward = Math.max(0, Number(ad.reward || 0));

      // Create a single-use watch session in Supabase
      const { data: session, error: sErr } = await supabase
        .from('ad_watch_sessions')
        .insert({ tg_id: tgId, ad_id: ad.id, required_seconds: seconds })
        .select('id')
        .single();

      if (sErr || !session) {
        console.error('❌ ad_watch_sessions insert error:', sErr);
        return ctx.reply('❌ Oturum oluşturulamadı. Supabase ad_watch_sessions tablosunu kontrol et.', mainMenu());
      }

      const url = `${WEB_BASE_URL.replace(/\/$/, '')}/ad/${session.id}`;

      const msg =
`🎥 *Reklam: ${ad.title || ('#' + ad.id)}*
⏱ Süre: *${seconds} sn*
🏁 Ödül: *${reward.toFixed(2)} TL*

1) *Videoyu Aç* butonuna bas
2) Sayfa açık kalsın, sayaç bitsin
3) Telegram'a dönüp *Ödülü Al* butonuna bas`;

      const kb = Markup.inlineKeyboard([
        [Markup.button.url('🔗 Videoyu Aç', url)],
        [Markup.button.callback('✅ Ödülü Al', `claim_${session.id}`)],
        [Markup.button.callback('⬅️ Menü', 'back_menu')],
      ]);

      return ctx.reply(msg, { parse_mode: 'Markdown', ...kb });
    } catch (err) {
      console.error(err);
      try { await ctx.answerCbQuery('Hata oluştu'); } catch {}
      return ctx.reply('❌ Reklam getirilemedi. Supabase tablolarını kontrol et.', mainMenu());
    }
  });

  // 2) Kullanıcı sayaç bitince "✅ Ödülü Al" butonuna basar (web sayfası completed_at yazar)
  bot.action(/^claim_(.+)$/i, async (ctx) => {
    const sessionId = String(ctx.match[1] || '').trim();
    const tgId = String(ctx.from.id);

    try {
      await ctx.answerCbQuery('Kontrol ediliyor...');

      const { data: sess, error: sErr } = await supabase
        .from('ad_watch_sessions')
        .select('id, tg_id, ad_id, required_seconds, completed_at')
        .eq('id', sessionId)
        .single();

      if (sErr || !sess) {
        return ctx.reply('❌ Oturum bulunamadı. Tekrar reklam başlat.', mainMenu());
      }
      if (String(sess.tg_id) !== tgId) {
        return ctx.reply('❌ Bu oturum sana ait değil.', mainMenu());
      }
      if (!sess.completed_at) {
        return ctx.reply('⏳ Sayaç bitmemiş görünüyor. Videoyu açık tutup bitince tekrar dene.', mainMenu());
      }

      const { data: ad, error: aErr } = await supabase
        .from('ads')
        .select('id, reward')
        .eq('id', sess.ad_id)
        .single();

      if (aErr || !ad) {
        return ctx.reply('❌ Reklam kaydı bulunamadı. Admin ads tablosunu kontrol et.', mainMenu());
      }

      const reward = Math.max(0, Number(ad.reward || 0));
      const newBal = await addBalance(tgId, reward);

      // Tekrar ödeme olmasın diye oturumu sil
      await supabase.from('ad_watch_sessions').delete().eq('id', sessionId);

      return ctx.reply(`✅ Ödül verildi: *${reward.toFixed(2)} TL*\n💰 Yeni bakiye: *${newBal.toFixed(2)} TL*`, {
        parse_mode: 'Markdown',
        ...mainMenu(),
      });
    } catch (err) {
      console.error(err);
      try { await ctx.answerCbQuery('Hata'); } catch {}
      return ctx.reply('❌ Ödül kontrolünde hata oldu. Tekrar dene.', mainMenu());
    }
  });

  bot.action('back_menu', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    await ctx.reply('Menü:', mainMenu());
  });

  await bot.launch();
  console.log('🤖 Bot (Supabase) çalışıyor');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})().catch((e) => {
  console.error('❌ Fatal bootstrap error:', e);
  process.exit(1);
});

/**
 * =========================
 * OPTIONAL HEALTH SERVER
 * =========================
 */
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`🌐 Health server running on ${PORT}`));
