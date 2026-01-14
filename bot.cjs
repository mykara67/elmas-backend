require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()
const path = require('path')

/* ================= ENV ================= */
const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_ID = Number(process.env.ADMIN_ID || 0)
const PORT = process.env.PORT || 10000
const DB_PATH = process.env.DB_PATH || './bot.db'

if (!BOT_TOKEN) {
  console.log('❌ BOT_TOKEN yok')
  process.exit(1)
}

/* ================= BOT ================= */
const bot = new Telegraf(BOT_TOKEN)

/* ================= DB ================= */
const db = new sqlite3.Database(DB_PATH)

const run = (q, p=[]) =>
  new Promise((res, rej) =>
    db.run(q, p, function (e) { e ? rej(e) : res(this) })
  )

const get = (q, p=[]) =>
  new Promise((res, rej) =>
    db.get(q, p, (e, r) => e ? rej(e) : res(r))
  )

/* ================= FORMAT ================= */
const fmt4 = n => Number(n || 0).toFixed(4)

/* ================= INIT DB ================= */
async function initDb () {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      token REAL DEFAULT 0,
      balance_tl REAL DEFAULT 0,
      daily_ads INTEGER DEFAULT 0,
      last_reset TEXT
    )
  `)
  console.log('✅ DB hazır (ADIM 20 - UX Sayaç + Admin)')
}

/* ================= MENU ================= */
const mainMenu = () =>
  Markup.keyboard([
    ['🎥 Reklam İzle', '💼 Cüzdan'],
    ['🏪 Market', '👥 Referans'],
    ['💸 Para Çek', '🔥 VIP'],
    ['🧬 GENESIS']
  ]).resize()

/* ================= START ================= */
bot.start(async ctx => {
  const id = ctx.from.id
  await run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, [id])
  ctx.reply('🎉 ElmasReklam Botuna Hoşgeldin!', mainMenu())
})

/* ================= WALLET ================= */
bot.hears('💼 Cüzdan', async ctx => {
  const u = await get(
    `SELECT token, balance_tl FROM users WHERE user_id=?`,
    [ctx.from.id]
  )
  ctx.reply(
    `💼 Cüzdan\n\n🪙 ELMAS: ${fmt4(u.token)}\n💰 TL: ${fmt4(u.balance_tl)}`,
    mainMenu()
  )
})

/* ================= MARKET (ELMAS → TL) ================= */
bot.hears('🏪 Market', async ctx => {
  const RATE = 0.0001
  const u = await get(
    `SELECT token, balance_tl FROM users WHERE user_id=?`,
    [ctx.from.id]
  )

  if (u.token <= 0) {
    return ctx.reply('❌ Dönüştürülecek elmas yok.', mainMenu())
  }

  const elmas = u.token
  const tl = Number(elmas) * RATE

  await run(`
    UPDATE users
    SET
      token = token - ?,
      balance_tl = balance_tl + ?
    WHERE user_id = ?
  `, [elmas, tl, ctx.from.id])

  const after = await get(
    `SELECT token, balance_tl FROM users WHERE user_id=?`,
    [ctx.from.id]
  )

  ctx.reply(
`Çevrildi!
-${fmt4(elmas)} ELMAS → +${fmt4(tl)} TL

🪙 ${fmt4(after.token)} ELMAS
💰 ${fmt4(after.balance_tl)} TL`,
    mainMenu()
  )
})

/* ================= GENESIS ================= */
bot.hears('🧬 GENESIS', ctx => {
  ctx.reply(
`🧬 GENESIS PANEL

✨ Özel kullanıcı modu
🚀 Yakında ekstra kazançlar`,
    mainMenu()
  )
})

/* ================= SAFETY ================= */
process.on('unhandledRejection', e => console.log('❌', e))
process.on('uncaughtException', e => console.log('❌', e))

/* ================= START APP ================= */
initDb().then(async () => {
  const me = await bot.telegram.getMe()
  console.log('🤖 Bot username:', me.username)

  bot.launch()
  console.log('🚀 Bot çalışıyor (ADIM 20)')
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

/* ================= WEBAPP ================= */
try {
  require('./webapp-server.cjs')
  console.log('✅ WebApp server başlatıldı')
} catch (e) {
  console.log('⚠️ WebApp server yok:', e.message)
}
