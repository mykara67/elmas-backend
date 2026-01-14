// webapp-server.cjs  (FINAL)
// Express WebApp server + Telegram initData auth + SQLite (packages + user_ads)
// Works on Render: listens on process.env.PORT, uses DB_PATH, serves /webapp static

require('dotenv').config()

const express = require('express')
const path = require('path')
const crypto = require('crypto')
const sqlite3 = require('sqlite3').verbose()

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN || ''
const ADMIN_ID = Number(process.env.ADMIN_ID || 0)
const DB_PATH = process.env.DB_PATH || './bot.db'

// Render uses PORT
const PORT = Number(process.env.PORT || process.env.WEBAPP_PORT || 3000)

// Token/TL price (must match bot.cjs)
const TOKEN_TL_PRICE = Number(process.env.TOKEN_TL_PRICE || 0.0001)

// initData security
const INITDATA_MAX_AGE_SEC = Number(process.env.INITDATA_MAX_AGE_SEC || 24 * 60 * 60) // 24h default

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing. Set BOT_TOKEN in Render Environment.')
  process.exit(1)
}

// ================= APP =================
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// CORS (WebApp runs inside Telegram; allow requests)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Static WebApp files at /webapp
app.use('/webapp', express.static(path.join(__dirname, 'webapp')))

// ================= DB =================
const db = new sqlite3.Database(DB_PATH)
// ================== DB INIT (FINAL) ==================
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

async function initDB() {
  // USERS
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      token REAL DEFAULT 0,
      balance_tl REAL DEFAULT 0,
      daily_ad_count INTEGER DEFAULT 0,
      last_reset_day TEXT,
      referrer_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // ADS (ADMIN + USER ADS)
  await run(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER,
      type TEXT,
      title TEXT,
      url TEXT,
      image TEXT,
      reward REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // PACKAGES (WEBAPP – REKLAM PAKETLERİ)
  await run(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      price_token REAL,
      ad_limit INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // USER ADS (KULLANICI OLUŞTURDUĞU REKLAMLAR)
  await run(`
    CREATE TABLE IF NOT EXISTS user_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ad_id INTEGER,
      views INTEGER DEFAULT 0,
      max_views INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // LOGS
  await run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      amount REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // INDEXLER (PERFORMANS)
  await run(`CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_ads_active ON ads(is_active)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_user_ads_user ON user_ads(user_id)`)

  // DEFAULT PACKAGES (SADECE 1 KEZ EKLENİR)
  const pkg = await get(`SELECT id FROM packages LIMIT 1`)
  if (!pkg) {
    await run(
      `INSERT INTO packages (name, price_token, ad_limit) VALUES
      ('Mini Paket', 10, 100),
      ('Standart Paket', 25, 300),
      ('Pro Paket', 50, 1000)`
    )
    console.log('✅ packages seeded')
  }

  console.log('✅ WebApp tables ready')
}

// ÇALIŞTIR
initDB().catch(e => {
  console.error('❌ DB INIT ERROR:', e)
  process.exit(1)
})
// ================== DB INIT (FINAL) ==================

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve(this)
    })
  })
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err)
      resolve(row)
    })
  })
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

async function ensureTables() {
  // packages
  await run(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      price_token REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `)

  // user ads created by users
  await run(`
    CREATE TABLE IF NOT EXISTS user_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      package_id INTEGER NOT NULL,
      type TEXT NOT NULL,                 -- LINK | PHOTO
      title TEXT DEFAULT '',
      link_url TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `)

  // Try ensure users table exists (bot.cjs usually creates it)
  // If not exist, create minimal to keep WebApp running.
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      token REAL NOT NULL DEFAULT 0,
      balance_tl REAL NOT NULL DEFAULT 0,
      referrer_id INTEGER,
      daily_ad_count INTEGER NOT NULL DEFAULT 0,
      last_reset_day TEXT DEFAULT '',
      pending_action TEXT DEFAULT '',
      pending_data TEXT DEFAULT ''
    )
  `)

  // Seed packages if empty
  const cnt = await get(`SELECT COUNT(*) as c FROM packages`)
  if (!cnt || cnt.c === 0) {
    const seeds = [
      { name: 'Starter (100 izlenme)', views: 100, price_token: 50 },
      { name: 'Pro (500 izlenme)', views: 500, price_token: 200 },
      { name: 'Mega (2000 izlenme)', views: 2000, price_token: 700 }
    ]
    for (const p of seeds) {
      await run(
        `INSERT INTO packages (name, views, price_token, is_active) VALUES (?,?,?,1)`,
        [p.name, p.views, p.price_token]
      )
    }
    console.log('✅ packages seeded')
  }

  console.log('✅ WebApp tables ready')
}

// ================= Telegram initData validation =================

function parseInitData(initData) {
  // initData looks like querystring: "query_id=...&user=...&auth_date=...&hash=..."
  const params = new URLSearchParams(initData)
  const obj = {}
  for (const [k, v] of params.entries()) obj[k] = v
  return obj
}

function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return { ok: false, error: 'initData missing' }

  const data = parseInitData(initData)
  const hash = data.hash
  if (!hash) return { ok: false, error: 'hash missing' }

  // auth_date freshness check (optional but recommended)
  const authDate = Number(data.auth_date || 0)
  if (!authDate) return { ok: false, error: 'auth_date missing' }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - authDate) > INITDATA_MAX_AGE_SEC) {
    return { ok: false, error: 'initData expired' }
  }

  // Build data_check_string: sorted "key=value" excluding hash
  const entries = []
  for (const k of Object.keys(data)) {
    if (k === 'hash') continue
    entries.push(`${k}=${data[k]}`)
  }
  entries.sort()
  const dataCheckString = entries.join('\n')

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  if (calcHash !== hash) return { ok: false, error: 'hash mismatch' }

  // Parse user json if exists
  let user = null
  try {
    if (data.user) user = JSON.parse(data.user)
  } catch (e) {
    return { ok: false, error: 'invalid user json' }
  }

  return { ok: true, user, data }
}

// Middleware to require auth
function requireAuth(req, res, next) {
  const initData =
    req.headers['x-telegram-init-data'] ||
    req.body?.initData ||
    req.query?.initData ||
    ''

  const v = verifyInitData(initData)
  if (!v.ok) return res.status(401).json({ ok: false, error: v.error })
  req.tg = v
  next()
}

// ================= Helpers =================

async function ensureUserRow(userId) {
  let u = await get(`SELECT user_id, token, balance_tl FROM users WHERE user_id=?`, [userId])
  if (!u) {
    await run(`INSERT INTO users (user_id, token, balance_tl) VALUES (?,?,?)`, [userId, 0, 0])
    u = { user_id: userId, token: 0, balance_tl: 0 }
  }
  return u
}

function toNum(x, def = 0) {
  const n = Number(x)
  return Number.isFinite(n) ? n : def
}

// ================= API =================

// Health
app.get('/health', (req, res) => res.json({ ok: true }))

// Auth handshake (optional; frontend can call this once)
app.post('/api/auth', (req, res) => {
  const initData = req.body?.initData || ''
  const v = verifyInitData(initData)
  if (!v.ok) return res.status(401).json({ ok: false, error: v.error })

  const userId = Number(v.user?.id || 0)
  const isAdmin = ADMIN_ID && userId === ADMIN_ID
  return res.json({ ok: true, user: v.user, is_admin: isAdmin })
})

// Current user + balances
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.tg.user?.id || 0)
    if (!userId) return res.status(400).json({ ok: false, error: 'user id missing' })

    const u = await ensureUserRow(userId)
    const isAdmin = ADMIN_ID && userId === ADMIN_ID

    res.json({
      ok: true,
      user: {
        id: userId,
        first_name: req.tg.user?.first_name || '',
        last_name: req.tg.user?.last_name || '',
        username: req.tg.user?.username || ''
      },
      balances: {
        token: toNum(u.token, 0),
        tl: toNum(u.balance_tl, 0),
        token_tl_price: TOKEN_TL_PRICE
      },
      is_admin: isAdmin
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Packages list
app.get('/api/packages', requireAuth, async (req, res) => {
  try {
    const pkgs = await all(
      `SELECT id, name, views, price_token, is_active FROM packages WHERE is_active=1 ORDER BY id ASC`
    )
    res.json({ ok: true, packages: pkgs })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// My ads
app.get('/api/my-ads', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.tg.user?.id || 0)
    const ads = await all(
      `SELECT id, package_id, type, title, link_url, photo_url, created_at, is_active
       FROM user_ads WHERE user_id=? ORDER BY id DESC`,
      [userId]
    )
    res.json({ ok: true, ads })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Create ad (deduct token)
app.post('/api/create-ad', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.tg.user?.id || 0)
    const packageId = Number(req.body?.package_id || 0)
    const type = String(req.body?.type || 'LINK').toUpperCase()
    const title = String(req.body?.title || '').slice(0, 80)

    let linkUrl = String(req.body?.link_url || '').trim()
    let photoUrl = String(req.body?.photo_url || '').trim()

    if (!packageId) return res.status(400).json({ ok: false, error: 'package_id required' })
    if (type !== 'LINK' && type !== 'PHOTO') return res.status(400).json({ ok: false, error: 'type must be LINK or PHOTO' })

    if (type === 'LINK') {
      if (!linkUrl || !/^https?:\/\//i.test(linkUrl)) {
        return res.status(400).json({ ok: false, error: 'link_url must be http(s) url' })
      }
      photoUrl = ''
    } else {
      // PHOTO mode: we accept photo_url for now (later: upload flow)
      if (!photoUrl || !/^https?:\/\//i.test(photoUrl)) {
        return res.status(400).json({ ok: false, error: 'photo_url must be http(s) url' })
      }
      linkUrl = linkUrl && /^https?:\/\//i.test(linkUrl) ? linkUrl : ''
    }

    const pkg = await get(`SELECT id, price_token, is_active FROM packages WHERE id=?`, [packageId])
    if (!pkg || pkg.is_active !== 1) return res.status(400).json({ ok: false, error: 'package not available' })

    const u = await ensureUserRow(userId)
    const priceTok = toNum(pkg.price_token, 0)
    const userTok = toNum(u.token, 0)

    if (userTok < priceTok) {
      return res.status(400).json({
        ok: false,
        error: 'insufficient token',
        need: priceTok,
        have: userTok
      })
    }

    // Deduct token + insert ad (transaction-ish)
    await run(`UPDATE users SET token = token - ? WHERE user_id=?`, [priceTok, userId])
    const createdAt = Math.floor(Date.now() / 1000)
    await run(
      `INSERT INTO user_ads (user_id, package_id, type, title, link_url, photo_url, created_at, is_active)
       VALUES (?,?,?,?,?,?,?,1)`,
      [userId, packageId, type, title, linkUrl, photoUrl, createdAt]
    )

    const after = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [userId])

    res.json({
      ok: true,
      message: 'ad created',
      balances: {
        token: toNum(after?.token, 0),
        tl: toNum(after?.balance_tl, 0)
      }
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ================= START =================
ensureTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log('✅ WebApp server başlatıldı')
      console.log(`🧬 WebApp server running on port ${PORT} (/webapp)`)
      console.log(`✅ Using DB: ${DB_PATH}`)
    })
  })
  .catch((e) => {
    console.error('❌ WebApp server init failed:', e)
    process.exit(1)
  })
