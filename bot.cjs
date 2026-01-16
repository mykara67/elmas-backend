require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_ID = Number(process.env.ADMIN_ID || 0)
const DB_PATH = process.env.DB_PATH || './bot.db'

if (!BOT_TOKEN) {
  console.log('❌ BOT_TOKEN yok')
  process.exit(1)
}

// ================= BOT =================
const bot = new Telegraf(BOT_TOKEN)

// ================= DB =================
const db = new sqlite3.Database(DB_PATH)

const run = (q, p = []) =>
  new Promise((res, rej) =>
    db.run(q, p, function (e) {
      if (e) rej(e)
      else res(this)
    })
  )

const get = (q, p = []) =>
  new Promise((res, rej) =>
    db.get(q, p, (e, r) => {
      if (e) rej(e)
      else res(r)
    })
  )

const all = (q, p = []) =>
  new Promise((res, rej) =>
    db.all(q, p, (e, rows) => {
      if (e) rej(e)
      else res(rows)
    })
  )

// ================= FORMAT =================
const fmt4 = (n) => Number(n || 0).toFixed(4)

// ================= DB MIGRATION =================
async function migrateDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      token REAL DEFAULT 0,
      balance_tl REAL DEFAULT 0,
      daily_ads INTEGER DEFAULT 0,
      last_reset TEXT,
      pending_action TEXT,
      pending_data TEXT,
      iban TEXT,
      vip INTEGER DEFAULT 0,
      vip_until TEXT,
      ref_code TEXT,
      referred_by INTEGER,
      referrals_count INTEGER DEFAULT 0
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      url TEXT,
      reward REAL DEFAULT 0,
      seconds INTEGER DEFAULT 15,
      is_active INTEGER DEFAULT 1,
      is_vip INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER,
      iban TEXT,
      amount REAL,
      status TEXT DEFAULT 'pending',
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  console.log('✅ DB migration tamam')
}

// ================= MENU =================
const mainMenu = () =>
  Markup.keyboard([
    ['🎥 Reklam İzle', '💼 Cüzdan'],
    ['🏪 Market', '👥 Referans'],
    ['💸 Para Çek', '🔥 VIP'],
    ['🧬 GENESIS']
  ]).resize()

// ================= START =================
bot.start(async (ctx) => {
  await run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, [ctx.from.id])
  ctx.reply('🎉 ElmasReklam Botuna Hoşgeldin!', mainMenu())
})

// ================= HANDLERS =================
bot.hears(['💼 Cüzdan', 'Cüzdan'], async (ctx) => {
  const u = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [ctx.from.id])
  ctx.reply(`💼 Cüzdan\n\n🪙 ELMAS: ${fmt4(u?.token)}\n💰 TL: ${fmt4(u?.balance_tl)}`, mainMenu())
})

bot.hears(['🏪 Market', 'Market'], async (ctx) => {
  const RATE = 0.0001
  const u = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [ctx.from.id])
  if (!u || u.token <= 0) {
    return ctx.reply('❌ Dönüştürülecek elmas yok.', mainMenu())
  }
  const tl = u.token * RATE
  await run(`UPDATE users SET token=0, balance_tl=balance_tl+? WHERE user_id=?`, [tl, ctx.from.id])
  ctx.reply(`✅ Market işlemi tamamlandı!\n+${fmt4(tl)} TL`, mainMenu())
})

bot.hears(['🎥 Reklam İzle', 'Reklam İzle'], (ctx) => {
  ctx.reply('🎥 Reklam sistemi yakında aktif edilecek.', mainMenu())
})

bot.hears(['👥 Referans', 'Referans'], (ctx) => {
  ctx.reply('👥 Referans sistemi yakında aktif edilecek.', mainMenu())
})

bot.hears(['💸 Para Çek', 'Para Çek'], (ctx) => {
  ctx.reply('💸 Para çekme sistemi yakında aktif edilecek.', mainMenu())
})

bot.hears(['🔥 VIP', 'VIP'], (ctx) => {
  ctx.reply('🔥 VIP sistemi yakında aktif edilecek.', mainMenu())
})

bot.hears(['🧬 GENESIS', 'GENESIS'], (ctx) => {
  ctx.reply('🧬 GENESIS PANEL\n✨ Özel kullanıcı modu', mainMenu())
})

// ================= START BOT =================
migrateDb().then(() => {
  bot.launch()
  console.log('🚀 Bot çalışıyor')
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
