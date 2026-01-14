require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_ID = Number(process.env.ADMIN_ID || 0) // şimdilik opsiyonel
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

// ================= MIGRATION HELPERS =================
async function tableInfo(table) {
  return all(`PRAGMA table_info(${table})`)
}
async function hasColumn(table, col) {
  const cols = await tableInfo(table)
  return cols.some((c) => c.name === col)
}
async function addColumnIfMissing(table, col, defSql) {
  const ok = await hasColumn(table, col)
  if (ok) return false
  await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${defSql}`)
  console.log(`✅ Column eklendi: ${table}.${col}`)
  return true
}

// ================= DB MIGRATION =================
async function migrateDb() {
  // --- users (mevcut yapıyı bozmadan) ---
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      token REAL DEFAULT 0,
      balance_tl REAL DEFAULT 0,
      daily_ads INTEGER DEFAULT 0,
      last_reset TEXT
    )
  `)

  // Sonraki adımlar için şimdiden kolonlar (güvenli)
  await addColumnIfMissing('users', 'pending_action', 'TEXT')
  await addColumnIfMissing('users', 'pending_data', 'TEXT')
  await addColumnIfMissing('users', 'iban', 'TEXT')
  await addColumnIfMissing('users', 'vip', 'INTEGER DEFAULT 0')
  await addColumnIfMissing('users', 'vip_until', 'TEXT')
  await addColumnIfMissing('users', 'ref_code', 'TEXT')
  await addColumnIfMissing('users', 'referred_by', 'INTEGER')
  await addColumnIfMissing('users', 'referrals_count', 'INTEGER DEFAULT 0')
  await addColumnIfMissing('users', 'last_reset_day', 'TEXT') // günlük sıfırlama için alternatif

  // --- ads (reklam sistemi için) ---
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

  // --- withdraw_requests (para çekim için) ---
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

  console.log('✅ DB migration tamam (ADIM 20 taban hazır)')
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
  const id = ctx.from.id
  await run(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`, [id])
  ctx.reply('🎉 ElmasReklam Botuna Hoşgeldin!', mainMenu())
})

// ================= WALLET =================
bot.hears('💼 Cüzdan', async (ctx) => {
  const u = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [ctx.from.id])
  ctx.reply(`💼 Cüzdan\n\n🪙 ELMAS: ${fmt4(u?.token)}\n💰 TL: ${fmt4(u?.balance_tl)}`, mainMenu())
})

// ================= MARKET (ELMAS → TL) =================
bot.hears('🏪 Market', async (ctx) => {
  const RATE = 0.0001 // 1 ELMAS = 0.0001 TL

  const u = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [ctx.from.id])
  const token = Number(u?.token || 0)

  if (token <= 0) {
    return ctx.reply('❌ Dönüştürülecek elmas yok.', mainMenu())
  }

  const elmas = token
  const tl = Number(elmas) * RATE

  await run(
    `UPDATE users SET token = token - ?, balance_tl = balance_tl + ? WHERE user_id = ?`,
    [elmas, tl, ctx.from.id]
  )

  const after = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [ctx.from.id])

  ctx.reply(
    `Çevrildi!\n-${fmt4(elmas)} ELMAS → +${fmt4(tl)} TL\n\n🪙 ${fmt4(after?.token)} ELMAS | 💰 ${fmt4(after?.balance_tl)} TL`,
    mainMenu()
  )
})

// ================= GENESIS =================
bot.hears('🧬 GENESIS', (ctx) => {
  ctx.reply(
    `🧬 GENESIS PANEL\n\n✨ Özel kullanıcı modu\n🚀 Yakında ekstra kazançlar`,
    mainMenu()
  )
})

// ================= SAFETY =================
process.on('unhandledRejection', (e) => console.log('❌ unhandledRejection:', e))
process.on('uncaughtException', (e) => console.log('❌ uncaughtException:', e))

// ================= WEBAPP SERVER (SAFE START) =================
if (!global.__WEBAPP_STARTED__) {
  global.__WEBAPP_STARTED__ = true
  try {
    require('./webapp-server.cjs')
    console.log('✅ WebApp server başlatıldı')
  } catch (e) {
    console.log('⚠️ WebApp server yok / başlatılamadı:', e.message)
  }
}

// ================= START APP =================
migrateDb().then(async () => {
  const me = await bot.telegram.getMe()
  console.log('✅ Bot username:', me.username)
  await bot.launch()
  console.log('🚀 Bot çalışıyor (ADIM 20 + MIGRATION)')
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
