const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

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

  const newBal = Number(u.balance_tl_tl || 0) + Number(amount || 0);

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
      await ctx.reply(`💰 Bakiye: ${Number(u.balance_tl_tl || 0).toFixed(2)}`);
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
      const nonce = Math.random().toString(36).slice(2, 8);

      await setPending(tgId, 'watch_ad', {
        ad_id: ad.id,
        nonce,
        seconds,
        reward,
        started: false,
        started_at: null,
      });

      const adText =
        `🎬 *${ad.title || 'Reklam'}*\n\n` +
        `${ad.text || ''}\n\n` +
        (ad.url ? `🔗 Link: ${ad.url}\n\n` : '') +
        `⏱ Süre: *${seconds} sn*\n` +
        `💸 Ödül: *${reward}*`;

      const kb = Markup.inlineKeyboard([
      ...(ad.url ? [[Markup.button.url('🔗 Reklamı Aç', ad.url)]] : []),
      [Markup.button.callback('✅ Reklamı Açtım', `ad_opened:${ad.id}:${nonce}`)],
      [Markup.button.callback('⬅️ Menü', 'back_menu')],
    ]);

      await ctx.reply(adText, { parse_mode: 'Markdown', ...kb });
    } catch (err) {
      console.error(err);
      try { await ctx.answerCbQuery('Hata oluştu'); } catch {}
      await ctx.reply('❌ Reklam getirilemedi. Supabase ads tablosunu kontrol et.', mainMenu());
    }
  });

  // 2) "▶️ Başlat" -> Sayaç -> Ödeme
  
  // 2) "✅ Reklamı Açtım" -> Kullanıcı linke tıkladığını onaylar, sonra sayaç butonu gösterilir
  bot.action(/^ad_opened:(\d+):([a-z0-9]{0,10})$/, async (ctx) => {
    const adId = Number(ctx.match[1]);
    const nonce = String(ctx.match[2] || '');

    try {
      await ctx.answerCbQuery();

      const tgId = String(ctx.from.id);
      const u = await upsertUser(tgId);

      if (u.pending_action !== 'watch_ad') {
        return ctx.reply('⚠️ Önce Menüden reklam başlat.', mainMenu());
      }

      const pd = u.pending_data || null;
      if (!pd || Number(pd.ad_id) !== adId) {
        return ctx.reply('⚠️ Reklam oturumu uyuşmuyor. Menüden tekrar dene.', mainMenu());
      }
      if (pd.nonce && nonce && String(pd.nonce) !== nonce) {
        return ctx.reply('⚠️ Bu reklam oturumu geçersiz. Menüden yeniden başlat.', mainMenu());
      }
      if (pd.nonce && nonce && String(pd.nonce) !== nonce) {
        return ctx.reply('⚠️ Bu reklam oturumu geçersiz. Menüden tekrar dene.', mainMenu());
      }

      const seconds = Math.max(10, Number(pd.seconds || 10));
      const reward = Number(pd.reward || 0);

      await setPending(tgId, 'watch_ad', {
        ...pd,
        open_confirmed: true,
        open_confirmed_at: Date.now(),
        started: false,
        started_at: null,
      });

      const text =
        `✅ Reklamı açtığını onayladın.\n\n` +
        `⏱ Süre: *${seconds} sn*\n` +
        `💸 Ödül: *${reward}*\n\n` +
        `Şimdi sayaç başlatabilirsin.`;

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback('▶️ Başlat (Sayaç)', `ad_start:${adId}:${pd.nonce || ''}`)],
        [Markup.button.callback('⬅️ Menü', 'back_menu')],
      ]);

      try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb });
      } catch {
        await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
      }
    } catch (err) {
      console.error(err);
      try { await ctx.answerCbQuery('Hata'); } catch {}
      await ctx.reply('❌ İşlem sırasında hata oluştu.', mainMenu());
    }
  });

bot.action(/^ad_start:(\d+):([a-z0-9]{0,10})$/, async (ctx) => {
    const adId = Number(ctx.match[1]);

    const nonce = String(ctx.match[2] || '');

    try {
      await ctx.answerCbQuery();

      const tgId = String(ctx.from.id);
      const u = await upsertUser(tgId);

      if (u.pending_action !== 'watch_ad') {
        return ctx.reply('⚠️ Bu işlem geçersiz. Menüden tekrar reklam başlat.', mainMenu());
      }

      const pd = u.pending_data || null;
      if (!pd || Number(pd.ad_id) !== adId) {
        return ctx.reply('⚠️ Reklam oturumu uyuşmuyor. Menüden tekrar dene.', mainMenu());
      }

      if (pd.started) {
        return ctx.reply('⏳ Sayaç zaten başlamış. Bitmesini bekle.', mainMenu());
      }

      const seconds = Math.max(10, Number(pd.seconds || 10));
      const reward = Number(pd.reward || 0);

      await setPending(tgId, 'watch_ad', {
        ...pd,
        started: true,
        started_at: Date.now(),
      });

      // Sayaç mesajını ayrı bir mesajda yönetelim (edit hatalarını azaltır)
      const baseText =
        `⏳ Reklam izleme sayacı başladı.\n` +
        `Süre dolunca otomatik ödeme yapılır.\n\n` +
        `🎥 Reklam ID: ${adId}\n` +
        `💸 Ödül: ${reward}`;

      const countdownMsg = await ctx.reply(`${baseText}\n\n⏱ Kalan: *${seconds} sn*`, {
        parse_mode: 'Markdown',
      });

      for (let t = seconds - 1; t >= 0; t--) {
        await sleep(1000);
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            countdownMsg.message_id,
            undefined,
            `${baseText}\n\n⏱ Kalan: *${t} sn*`,
            { parse_mode: 'Markdown' }
          );
        } catch {
          // edit olmazsa sorun değil
        }
      }

      const newBal = await addBalance(tgId, reward);
      console.log(`✅ reward paid: tg=${tgId} ad=${adId} reward=${reward} newBal=${newBal}`);

      await setPending(tgId, null, null);

      await ctx.reply(
        `✅ Süre doldu! *${reward}* ödeme yapıldı.\n💰 Yeni bakiye: *${newBal.toFixed(2)}*`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
    } catch (err) {
      console.error(err);
      try { await ctx.answerCbQuery('Hata'); } catch {}

      try {
        await setPending(String(ctx.from.id), null, null);
      } catch {}

      await ctx.reply('❌ Sayaç/ödeme sırasında hata oluştu. Menüden tekrar dene.', mainMenu());
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
