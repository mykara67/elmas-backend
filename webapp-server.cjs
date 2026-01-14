// webapp-server.cjs
require('dotenv').config()

const express = require('express')
const path = require('path')
const crypto = require('crypto')
const sqlite3 = require('sqlite3').verbose()

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN
const WEBAPP_PORT = Number(process.env.PORT || process.env.WEBAPP_PORT || 3000)
const DB_PATH = process.env.DB_PATH || './bot.db'

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing in .env')
  process.exit(1)
}

// ================= APP =================
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// Static WebApp files
app.use('/webapp', express.static(path.join(__dirname, 'webapp')))

// ================= DB =================
const db = new sqlite3.Database(DB_PATH)

// ---------- helpers ----------
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err)
      else resolve(row)
    })
  })
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

// ------------------ DB INIT (packages + user_ads) ------------------
async function initTables() {
  await run(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price_elmas INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      max_views INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS user_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,              -- LINK | PHOTO
      title TEXT DEFAULT '',
      link TEXT DEFAULT '',
      photo_file_id TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      max_views INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `)

  const cnt = await get(`SELECT COUNT(*) as c FROM packages`)
  if ((cnt?.c || 0) === 0) {
    await run(
      `INSERT INTO packages (name, price_elmas, duration_days, max_views, is_active)
       VALUES
       ('1 Gün / 500 Gösterim', 5000, 1, 500, 1),
       ('3 Gün / 2000 Gösterim', 18000, 3, 2000, 1),
       ('7 Gün / 6000 Gösterim', 40000, 7, 6000, 1)`
    )
    console.log('✅ packages seeded')
  }

  console.log('✅ WebApp tables ready')
}

// ------------------ Telegram WebApp initData verify ------------------
function parseInitData(initData) {
  const params = new URLSearchParams(initData)
  const data = {}
  for (const [k, v] of params.entries()) data[k] = v
  return data
}

function verifyTelegramWebAppData(initData, botToken) {
  const data = parseInitData(initData)
  const hash = data.hash
  if (!hash) return { ok: false, reason: 'hash missing' }
  delete data.hash

  const dataCheckString = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n')

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest()

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex')

  if (computedHash !== hash) return { ok: false, reason: 'hash mismatch' }

  let user = null
  try {
    user = JSON.parse(data.user || '{}')
  } catch {
    user = null
  }

  return { ok: true, user, raw: data }
}

async function ensureUserRow(userId) {
  // users tablosu bot tarafında var varsayılır
  const row = await get(`SELECT id FROM users WHERE user_id = ?`, [userId]).catch(() => null)
  if (!row) {
    await run(
      `INSERT INTO users (user_id, elmas_balance, tl_balance, created_at)
       VALUES (?, 0, 0, ?)`,
      [userId, Date.now()]
    ).catch(() => {})
  }
}

async function auth(req, res, next) {
  try {
    const initData = req.body.initData || req.headers['x-telegram-initdata']
    if (!initData) return res.status(401).json({ ok: false, error: 'initData missing' })

    const v = verifyTelegramWebAppData(initData, BOT_TOKEN)
    if (!v.ok || !v.user?.id) return res.status(401).json({ ok: false, error: 'auth failed', reason: v.reason })

    req.tgUser = v.user
    await ensureUserRow(v.user.id)
    next()
  } catch {
    res.status(500).json({ ok: false, error: 'server error' })
  }
}

// ------------------ API ------------------
app.post('/api/me', auth, async (req, res) => {
  const userId = req.tgUser.id
  const u = await get(`SELECT user_id, elmas_balance, tl_balance FROM users WHERE user_id = ?`, [userId])
  res.json({ ok: true, user: req.tgUser, balances: u })
})

app.post('/api/packages', auth, async (req, res) => {
  const rows = await all(`SELECT * FROM packages WHERE is_active = 1 ORDER BY id ASC`)
  res.json({ ok: true, packages: rows })
})

app.post('/api/myAds', auth, async (req, res) => {
  const userId = req.tgUser.id
  const rows = await all(
    `SELECT id, type, title, link, created_at, expires_at, max_views, views, clicks, is_active
     FROM user_ads
     WHERE user_id = ?
     ORDER BY id DESC`,
    [userId]
  )
  res.json({ ok: true, ads: rows })
})

app.post('/api/createUserAd', auth, async (req, res) => {
  const userId = req.tgUser.id
  const { packageId, type, title, link, photo_file_id } = req.body

  const pkg = await get(`SELECT * FROM packages WHERE id = ? AND is_active = 1`, [packageId])
  if (!pkg) return res.json({ ok: false, error: 'Paket bulunamadı' })

  const u = await get(`SELECT elmas_balance FROM users WHERE user_id = ?`, [userId])
  const elmas = Number(u?.elmas_balance || 0)
  if (elmas < pkg.price_elmas) return res.json({ ok: false, error: 'Yetersiz ELMAS' })

  if (!['LINK', 'PHOTO'].includes(type)) return res.json({ ok: false, error: 'type invalid' })
  if (type === 'LINK' && (!link || link.length < 5)) return res.json({ ok: false, error: 'link gerekli' })
  if (type === 'PHOTO' && (!photo_file_id || photo_file_id.length < 5)) return res.json({ ok: false, error: 'photo_file_id gerekli' })

  const now = Date.now()
  const expiresAt = now + Number(pkg.duration_days) * 24 * 60 * 60 * 1000

  await run(`UPDATE users SET elmas_balance = elmas_balance - ? WHERE user_id = ?`, [pkg.price_elmas, userId])

  const r = await run(
    `INSERT INTO user_ads (user_id, type, title, link, photo_file_id, created_at, expires_at, max_views, views, clicks, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1)`,
    [userId, type, title || '', link || '', photo_file_id || '', now, expiresAt, Number(pkg.max_views || 0)]
  )

  res.json({ ok: true, adId: r.lastID })
})

// Health
app.get('/health', (req, res) => res.send('ok'))

// ------------------ Start ------------------
initTables()
  .then(() => {
    app.listen(WEBAPP_PORT, () => {
      console.log(`🧬 WebApp server running on port ${WEBAPP_PORT} (/webapp)`)
    })
  })
  .catch((e) => {
    console.error('❌ initTables error', e)
    process.exit(1)
  })
