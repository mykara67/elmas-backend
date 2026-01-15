require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_ID = Number(process.env.ADMIN_ID || 0)

// Supabase (server-side)
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY // prefer SERVICE_ROLE

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('❌ SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY yok')
  process.exit(1)
}

T_TOKEN) {
  console.log('❌ BOT_TOKEN yok')
  process.exit(1)
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('❌ SUPABASE_URL veya SUPABASE_KEY yok (SUPABASE_SERVICE_ROLE_KEY önerilir)')
  process.exit(1)
}

// ================= BOT =================
const bot = new Telegraf(BOT_TOKEN)

// ================= SUPABASE =================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

// ================= FORMAT =================
const fmt4 = (n) => Number(n || 0).toFixed(4)

// ================= HELPERS =================
function mainMenu() {
  return Markup.keyboard([
    ['🎥 Reklam İzle', '💼 Cüzdan'],
    ['🏪 Market', '👥 Referans'],
    ['💸 Para Çek', '🔥 VIP'],
    ['🧬 GENESIS']
  ]).resize()
}

function genRefCode(telegramId) {
  // short stable-ish code: base36 + 4 hex
  const tail = crypto.createHash('sha1').update(String(telegramId)).digest('hex').slice(0, 4)
  return `${telegramId.toString(36)}${tail}`.toUpperCase()
}

async function ensureUser(ctx) {
  const telegram_id = ctx.from.id
  const username = ctx.from.username || null
  const first_name = ctx.from.first_name || null

  // Try fetch
  const { data: existing, error: e1 } = await supabase
    .from('users')
    .select('telegram_id, ref_code')
    .eq('telegram_id', telegram_id)
    .maybeSingle()

  if (e1) throw e1

  if (existing) {
    // update username/first_name if changed
    await supabase.from('users').update({ username, first_name }).eq('telegram_id', telegram_id)
    return existing
  }

  // create with ref_code
  const ref_code = genRefCode(telegram_id)
  const { data: inserted, error: e2 } = await supabase
    .from('users')
    .insert({ telegram_id, username, first_name, ref_code })
    .select('telegram_id, ref_code')
    .single()

  if (!e2) return inserted

  // if ref_code unique collision (very unlikely), retry once
  const ref_code2 = `${ref_code}${crypto.randomBytes(1).toString('hex')}`.toUpperCase()
  const { data: inserted2, error: e3 } = await supabase
    .from('users')
    .insert({ telegram_id, username, first_name, ref_code: ref_code2 })
    .select('telegram_id, ref_code')
    .single()

  if (e3) throw e3
  return inserted2
}

async function getUserBalances(telegram_id) {
  const { data, error } = await supabase
    .from('users')
    .select('token, balance_tl, vip, referrals_count, ref_code')
    .eq('telegram_id', telegram_id)
    .single()
  if (error) throw error
  return data
}

// ================= START =================
bot.start(async (ctx) => {
  try {
    // Optional ref handling: /start ABC123
    const parts = (ctx.message?.text || '').trim().split(/\s+/)
    const ref = parts[1] ? String(parts[1]).trim() : null

    const u = await ensureUser(ctx)

    if (ref && ref !== u.ref_code) {
      // attach referred_by once if empty
      const { data: me, error: eMe } = await supabase
        .from('users')
        .select('referred_by')
        .eq('telegram_id', ctx.from.id)
        .single()
      if (eMe) throw eMe

      if (!me.referred_by) {
        // find owner of ref_code
        const { data: owner, error: eOw } = await supabase
          .from('users')
          .select('telegram_id')
          .eq('ref_code', ref)
          .maybeSingle()
        if (!eOw && owner && owner.telegram_id !== ctx.from.id) {
          await supabase.from('users').update({ referred_by: owner.telegram_id }).eq('telegram_id', ctx.from.id)
          // increment referrals_count
          await supabase.rpc('increment_referrals', { p_telegram_id: owner.telegram_id }).catch(() => {})
        }
      }
    }

    ctx.reply('🎉 ElmasReklam Botuna Hoşgeldin!', mainMenu())
  } catch (e) {
    console.log('❌ /start error:', e)
    ctx.reply('❌ Bir hata oldu. Biraz sonra tekrar dene.')
  }
})

// ================= WALLET =================
bot.hears(['💼 Cüzdan', 'Cüzdan'], async (ctx) => {
  try {
    await ensureUser(ctx)
    const b = await getUserBalances(ctx.from.id)
    ctx.reply(
      `💼 Cüzdan\n\n🪙 ELMAS: ${fmt4(b.token)}\n💰 TL: ${fmt4(b.balance_tl)}\n👥 Ref: ${b.referrals_count || 0}\n🔗 Kod: ${b.ref_code || '-'}`,
      mainMenu()
    )
  } catch (e) {
    console.log('❌ wallet error:', e)
    ctx.reply('❌ Cüzdan okunamadı.', mainMenu())
  }
})

// ================= MARKET (ELMAS → TL) =================
bot.hears(['🏪 Market', 'Market'], async (ctx) => {
  try {
    await ensureUser(ctx)
    const RATE = 0.0001
    const b = await getUserBalances(ctx.from.id)
    const token = Number(b.token || 0)

    if (token <= 0) return ctx.reply('❌ Dönüştürülecek elmas yok.', mainMenu())

    const tl = token * RATE

    // Atomic-ish update via RPC is best; here we do update with calculated values
    const { error } = await supabase
      .from('users')
      .update({ token: 0, balance_tl: Number(b.balance_tl || 0) + tl })
      .eq('telegram_id', ctx.from.id)

    if (error) throw error
    ctx.reply(`✅ Çevrildi!\n-${fmt4(token)} ELMAS → +${fmt4(tl)} TL`, mainMenu())
  } catch (e) {
    console.log('❌ market error:', e)
    ctx.reply('❌ Market işleminde hata oldu.', mainMenu())
  }
})

// ================= PLACEHOLDER HANDLERS =================
bot.hears(['🎥 Reklam İzle', 'Reklam İzle'], (ctx) => ctx.reply('🎥 Reklam sistemi (sayaç + ödeme) sıradaki adım.', mainMenu()))
bot.hears(['👥 Referans', 'Referans'], async (ctx) => {
  try {
    await ensureUser(ctx)
    const b = await getUserBalances(ctx.from.id)
    ctx.reply(`👥 Referans\n\n🔗 Davet linkin:\nhttps://t.me/${(await bot.telegram.getMe()).username}?start=${b.ref_code}`, mainMenu())
  } catch {
    ctx.reply('👥 Referans bilgisi alınamadı.', mainMenu())
  }
})
bot.hears(['💸 Para Çek', 'Para Çek'], (ctx) => ctx.reply('💸 Para çekme sistemi sıradaki adım.', mainMenu()))
bot.hears(['🔥 VIP', 'VIP'], (ctx) => ctx.reply('🔥 VIP sistemi sıradaki adım.', mainMenu()))
bot.hears(['🧬 GENESIS', 'GENESIS'], (ctx) => ctx.reply('🧬 GENESIS PANEL\n✨ Özel kullanıcı modu', mainMenu()))

// ================= LOG / SAFE =================
process.on('unhandledRejection', (e) => console.log('❌ unhandledRejection:', e))
process.on('uncaughtException', (e) => console.log('❌ uncaughtException:', e))

bot.launch().then(async () => {
  const me = await bot.telegram.getMe()
  console.log('✅ Bot username:', me.username)
  console.log('🚀 Bot (Supabase) çalışıyor')
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
