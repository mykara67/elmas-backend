// webapp-server.cjs (Supabase version)
require('dotenv').config()
const express = require('express')
const path = require('path')
const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

const BOT_TOKEN = process.env.BOT_TOKEN || ''
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('❌ WebApp: SUPABASE_URL veya KEY yok')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

// ---- CORS ----
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

app.get('/', (req, res) => res.redirect('/webapp/'))

// ---- Static WebApp ----
app.use('/webapp', express.static(path.join(__dirname, 'webapp'), { extensions: ['html'] }))

// ---- Telegram initData validation (optional strict) ----
function verifyInitData(initData) {
  try {
    if (!BOT_TOKEN) return false
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) return false
    params.delete('hash')
    // data-check-string
    const pairs = []
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`)
    pairs.sort()
    const dataCheckString = pairs.join('\n')

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
    return computed.toLowerCase() === hash.toLowerCase()
  } catch {
    return false
  }
}

function getTelegramIdFromInitData(initData) {
  const params = new URLSearchParams(initData)
  const userStr = params.get('user')
  if (!userStr) return null
  const u = JSON.parse(userStr)
  return u?.id || null
}

app.post('/api/me', async (req, res) => {
  const initData = req.body?.initData || ''
  if (!verifyInitData(initData)) return res.status(401).json({ ok: false, error: 'bad_init_data' })
  const telegram_id = getTelegramIdFromInitData(initData)
  if (!telegram_id) return res.status(400).json({ ok: false, error: 'no_user' })

  const { data, error } = await supabase
    .from('users')
    .select('telegram_id, username, first_name, token, balance_tl, vip')
    .eq('telegram_id', telegram_id)
    .maybeSingle()

  if (error) return res.status(500).json({ ok: false, error: error.message })
  if (!data) return res.json({ ok: true, user: { telegram_id, token: 0, balance_tl: 0, vip: False } })
  return res.json({ ok: true, user: data })
})

app.get('/api/packages', async (req, res) => {
  // Placeholder: you can store packages table in Supabase later.
  return res.json({
    ok: true,
    packages: [
      { id: 'P1', title: 'Mini', price_elmas: 1000, total_views: 100 },
      { id: 'P2', title: 'Standart', price_elmas: 3000, total_views: 350 },
      { id: 'P3', title: 'Pro', price_elmas: 8000, total_views: 1000 }
    ]
  })
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => console.log(`🧬 WebApp server running on port ${PORT} (/webapp)`))
