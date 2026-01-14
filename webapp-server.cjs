// webapp-server.cjs (FINAL - Render + Telegram WebApp initData auth + SQLite)
// Fixes: duplicate declarations, auto-creates missing tables (users etc.)

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

// Must match bot.cjs default
const TOKEN_TL_PRICE = Number(process.env.TOKEN_TL_PRICE || 0.0001)
const INITDATA_MAX_AGE_SEC = Number(process.env.INITDATA_MAX_AGE_SEC || 24 * 60 * 60) // 24h

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing. Set BOT_TOKEN in Render Environment.')
  process.exit(1)
}

// ================= APP =================
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// CORS (safe for Telegram WebApp)
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

async function initDB() {
  // Users table (compatible with bot.cjs)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      token REAL NOT NULL DEFAULT 0,
      balance_tl REAL NOT NULL DEFAULT 0,
      referrer_id INTEGER,
      daily_ad_count INTEGER NOT NULL DEFAULT 0,
      last_reset_day TEXT DEFAULT '',
      pending_action TEXT DEFAULT '',
      pending_data TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Ads (admin ads watched by users)
  await run(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,         -- LINK | PHOTO
      title TEXT DEFAULT '',
      url TEXT DEFAULT '',
      file_id TEXT DEFAULT '',    -- telegram file_id (optional)
      reward REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Packages (for user self-ads)
  await run(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      price_token REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // User-created ads (metadata)
  await run(`
    CREATE TABLE IF NOT EXISTS user_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      package_id INTEGER NOT NULL,
      type TEXT NOT NULL,         -- LINK | PHOTO
      title TEXT DEFAULT '',
      link_url TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `)

  // Logs (optional)
  await run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      amount REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Seed packages once
  const cnt = await get(`SELECT COUNT(*) as c FROM packages`)
  if (!cnt || cnt.c === 0) {
    const seeds = [
      { name: 'Mini Paket (100 izlenme)', views: 100, price_token: 10 },
      { name: 'Standart Paket (300 izlenme)', views: 300, price_token: 25 },
      { name: 'Pro Paket (1000 izlenme)', views: 1000, price_token: 50 }
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

  const authDate = Number(data.auth_date || 0)
  if (!authDate) return { ok: false, error: 'auth_date missing' }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - authDate) > INITDATA_MAX_AGE_SEC) return { ok: false, error: 'initData expired' }

  const entries = []
  for (const k of Object.keys(data)) {
    if (k === 'hash') continue
    entries.push(`${k}=${data[k]}`)
  }
  entries.sort()
  const dataCheckString = entries.join('\n')

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  if (calcHash !== String(hash).toLowerCase()) return { ok: false, error: 'hash mismatch' }

  let user = null
  try {
    if (data.user) user = JSON.parse(data.user)
  } catch {
    return { ok: false, error: 'invalid user json' }
  }

  return { ok: true, user, data }
}

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

async function ensureUserRow(userId, username = '') {
  const u = await get(`SELECT user_id, token, balance_tl FROM users WHERE user_id=?`, [userId])
  if (u) return u
  await run(`INSERT INTO users (user_id, username, token, balance_tl) VALUES (?,?,?,?)`, [userId, username, 0, 0])
  return { user_id: userId, token: 0, balance_tl: 0 }
}

function toNum(x, def = 0) {
  const n = Number(x)
  return Number.isFinite(n) ? n : def
}

app.get('/', (req, res) => res.redirect('/webapp/'))

// ================= API =================
app.get('/health', (req, res) => res.json({ ok: true }))

app.post('/api/auth', (req, res) => {
  const initData = req.body?.initData || ''
  const v = verifyInitData(initData)
  if (!v.ok) return res.status(401).json({ ok: false, error: v.error })
  const userId = Number(v.user?.id || 0)
  return res.json({ ok: true, user: v.user, is_admin: ADMIN_ID && userId === ADMIN_ID })
})

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.tg.user?.id || 0)
    if (!userId) return res.status(400).json({ ok: false, error: 'user id missing' })

    const username = req.tg.user?.username || ''
    const u = await ensureUserRow(userId, username)

    res.json({
      ok: true,
      user: {
        id: userId,
        first_name: req.tg.user?.first_name || '',
        last_name: req.tg.user?.last_name || '',
        username
      },
      balances: {
        token: toNum(u.token, 0),
        tl: toNum(u.balance_tl, 0),
        token_tl_price: TOKEN_TL_PRICE
      },
      is_admin: ADMIN_ID && userId === ADMIN_ID
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/api/packages', requireAuth, async (req, res) => {
  try {
    const pkgs = await all(`SELECT id, name, views, price_token, is_active FROM packages WHERE is_active=1 ORDER BY id ASC`)
    res.json({ ok: true, packages: pkgs })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

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

app.post('/api/create-ad', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.tg.user?.id || 0)
    const username = req.tg.user?.username || ''
    await ensureUserRow(userId, username)

    const packageId = Number(req.body?.package_id || 0)
    const type = String(req.body?.type || 'LINK').toUpperCase()
    const title = String(req.body?.title || '').slice(0, 80)

    let linkUrl = String(req.body?.link_url || '').trim()
    let photoUrl = String(req.body?.photo_url || '').trim()

    if (!packageId) return res.status(400).json({ ok: false, error: 'package_id required' })
    if (type !== 'LINK' && type !== 'PHOTO') return res.status(400).json({ ok: false, error: 'type must be LINK or PHOTO' })

    if (type === 'LINK') {
      if (!linkUrl || !/^https?:\/\//i.test(linkUrl)) return res.status(400).json({ ok: false, error: 'link_url must be http(s) url' })
      photoUrl = ''
    } else {
      if (!photoUrl || !/^https?:\/\//i.test(photoUrl)) return res.status(400).json({ ok: false, error: 'photo_url must be http(s) url' })
      linkUrl = linkUrl && /^https?:\/\//i.test(linkUrl) ? linkUrl : ''
    }

    const pkg = await get(`SELECT id, price_token, is_active FROM packages WHERE id=?`, [packageId])
    if (!pkg || pkg.is_active !== 1) return res.status(400).json({ ok: false, error: 'package not available' })

    const u = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [userId])
    const priceTok = toNum(pkg.price_token, 0)
    const userTok = toNum(u?.token, 0)
    if (userTok < priceTok) return res.status(400).json({ ok: false, error: 'insufficient token', need: priceTok, have: userTok })

    await run(`UPDATE users SET token = token - ? WHERE user_id=?`, [priceTok, userId])
    const createdAt = Math.floor(Date.now() / 1000)
    await run(
      `INSERT INTO user_ads (user_id, package_id, type, title, link_url, photo_url, created_at, is_active)
       VALUES (?,?,?,?,?,?,?,1)`,
      [userId, packageId, type, title, linkUrl, photoUrl, createdAt]
    )

    const after = await get(`SELECT token, balance_tl FROM users WHERE user_id=?`, [userId])
    res.json({ ok: true, message: 'ad created', balances: { token: toNum(after?.token, 0), tl: toNum(after?.balance_tl, 0) } })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ================= START =================
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log('✅ WebApp server başlatıldı')
      console.log(`🧬 WebApp server running on port ${PORT} (/webapp)`)
      console.log(`✅ Using DB: ${DB_PATH}`)
    })
  })
  .catch((e) => {
    console.error('❌ DB INIT ERROR:', e)
    process.exit(1)
  })
