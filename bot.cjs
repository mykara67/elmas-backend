require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()

/* ================= ENV ================= */
const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_ID = Number(process.env.ADMIN_ID || 0)
const WEBAPP_URL = process.env.WEBAPP_URL || ''
if (!BOT_TOKEN) { console.log('❌ BOT_TOKEN yok'); process.exit(1) }

/* ================= DB ================= */
const db = new sqlite3.Database('./bot.db')
const run = (s, p = []) => new Promise((r, j) => db.run(s, p, function (e) { e ? j(e) : r(this) }))
const get = (s, p = []) => new Promise((r, j) => db.get(s, p, (e, d) => e ? j(e) : r(d)))
const all = (s, p = []) => new Promise((r, j) => db.all(s, p, (e, d) => e ? j(e) : r(d)))

/* ================= CONFIG ================= */
const DAILY_AD_LIMIT = 10
const TOKEN_PER_SEC = 0.02
const TOKEN_TL_PRICE = 0.0001
const BTN_COOLDOWN_SEC = 30
const REF_AD_SHARE_PCT = 10

const ADMIN_ADS_PAGE_SIZE = 10

// Reklam timer UX (edit rate limit yememek için)
const TICK_MS = 2000 // 2sn de bir güncelle
const MAX_TICKS = 60 // çok uzun reklam olursa spam olmasın diye (fallback claim yine var)

/* ================= HELPERS ================= */
const now = () => Math.floor(Date.now() / 1000)
const today = () => new Date().toISOString().slice(0, 10)
const fmt2 = n => Number(n || 0).toFixed(2)
const fmt4 = n => Number(n || 0).toFixed(4)
const toNum = (x) => Number(String(x).replace(',', '.'))
const clampInt = (n, a, b) => Math.max(a, Math.min(b, n))
const isHttp = (u) => /^https?:\/\/.+/i.test(String(u || '').trim())

function isAdmin(ctx) {
  return Number(ctx.from?.id || 0) === ADMIN_ID && ADMIN_ID !== 0
}

async function addCol(t, c, ty) {
  const i = await all(`PRAGMA table_info(${t})`)
  if (!i.some(x => x.name === c)) {
    await run(`ALTER TABLE ${t} ADD COLUMN ${c} ${ty}`)
    console.log(`✅ ${t}.${c} eklendi`)
  }
}

/* ================= LEDGER / LOG ================= */
async function ledgerAdd(userId, kind, amount, note = '') {
  await run(
    `INSERT INTO wallet_ledger(user_id,kind,amount,note) VALUES(?,?,?,?)`,
    [Number(userId), String(kind), Number(amount), String(note || '')]
  )
}
async function logEvent(userId, type, detail = '') {
  await run(
    `INSERT INTO logs(user_id,type,detail) VALUES(?,?,?)`,
    [Number(userId), String(type || ''), String(detail || '')]
  )
}

/* ================= COOLDOWN ================= */
async function cdRemaining(userId, key) {
  const row = await get(`SELECT until_ts FROM cooldowns WHERE user_id=? AND key=?`, [userId, key])
  if (!row) return 0
  const rem = Number(row.until_ts || 0) - now()
  return rem > 0 ? rem : 0
}
async function cdSet(userId, key, seconds) {
  const until = now() + Math.floor(seconds)
  await run(
    `INSERT INTO cooldowns(user_id,key,until_ts) VALUES(?,?,?)
     ON CONFLICT(user_id,key) DO UPDATE SET until_ts=excluded.until_ts`,
    [userId, key, until]
  )
}
async function guardCooldown(ctx, key) {
  const rem = await cdRemaining(ctx.from.id, key)
  if (rem > 0) {
    try { await ctx.answerCbQuery(`⏳ ${rem}s sonra`, { show_alert: false }) } catch {}
    return false
  }
  await cdSet(ctx.from.id, key, BTN_COOLDOWN_SEC)
  return true
}

/* ================= STATE ================= */
const setState = (u, s, d = {}) => run(
  `INSERT INTO user_states(user_id,state,data)
   VALUES(?,?,?)
   ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data`,
  [u, s, JSON.stringify(d || {})]
)
const getState = async (u) => {
  const r = await get(`SELECT * FROM user_states WHERE user_id=?`, [u])
  if (!r) return null
  let data = {}
  try { data = JSON.parse(r.data || '{}') } catch {}
  return { state: r.state, data }
}
const clearState = (u) => run(`DELETE FROM user_states WHERE user_id=?`, [u])

/* ================= REFERRAL ================= */
let BOT_USERNAME = ''
async function applyReferralIfAny(ctx, userId) {
  const payload = String(ctx.startPayload || '').trim()
  if (!payload) return
  const refId = Number(payload.replace(/\D/g, ''))
  if (!refId) return
  if (refId === Number(userId)) return

  const me = await get(`SELECT referrer_id FROM users WHERE user_id=?`, [userId])
  if (!me || me.referrer_id) return

  const refUser = await get(`SELECT user_id FROM users WHERE user_id=?`, [refId])
  if (!refUser) return

  await run(`UPDATE users SET referrer_id=? WHERE user_id=?`, [refId, userId])
  await ledgerAdd(refId, 'REF_NEW_USER', 0, `newUser=${userId}`)
  await logEvent(refId, 'REF_NEW_USER', `newUser=${userId}`)
}

async function payReferralShare(referredUserId, earnedTok, bot) {
  const u = await get(`SELECT referrer_id FROM users WHERE user_id=?`, [referredUserId])
  const refId = Number(u?.referrer_id || 0)
  if (!refId) return

  const share = Number(earnedTok) * (REF_AD_SHARE_PCT / 100)
  if (share <= 0) return

  await run(`UPDATE users SET token=token+? WHERE user_id=?`, [share, refId])
  await ledgerAdd(refId, 'REF_AD_SHARE', +share, `from=${referredUserId} pct=${REF_AD_SHARE_PCT}`)
  await logEvent(refId, 'REF_AD_SHARE', `+${share} TOK from=${referredUserId}`)
  try { await bot.telegram.sendMessage(refId, `👥 Referans geliri!\n+${fmt4(share)} ELMAS`) } catch {}
}

/* ================= INIT DB ================= */
async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users(
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      token REAL DEFAULT 0,
      balance_tl REAL DEFAULT 0,
      daily_ad_count INTEGER DEFAULT 0,
      last_reset_day TEXT,
      referrer_id INTEGER DEFAULT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS ads(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      url TEXT,
      seconds INTEGER,
      owner_user_id INTEGER,
      expires_at INTEGER,
      is_active INTEGER DEFAULT 1,
      ad_type TEXT DEFAULT 'LINK',
      image_file_id TEXT DEFAULT NULL
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS ad_sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ad_id INTEGER,
      started_at INTEGER,
      required_seconds INTEGER,
      rewarded INTEGER DEFAULT 0
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS wallet_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      kind TEXT,
      amount REAL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS user_states(
      user_id INTEGER PRIMARY KEY,
      state TEXT,
      data TEXT DEFAULT ''
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS cooldowns(
      user_id INTEGER,
      key TEXT,
      until_ts INTEGER,
      PRIMARY KEY(user_id,key)
    )
  `)

  // ===== MIGRATIONS =====
  await addCol('users', 'balance_tl', 'REAL DEFAULT 0')
  await addCol('users', 'daily_ad_count', 'INTEGER DEFAULT 0')
  await addCol('users', 'last_reset_day', 'TEXT')
  await addCol('users', 'referrer_id', 'INTEGER DEFAULT NULL')

  await addCol('ads', 'owner_user_id', 'INTEGER')
  await addCol('ads', 'expires_at', 'INTEGER')
  await addCol('ads', 'ad_type', "TEXT DEFAULT 'LINK'")
  await addCol('ads', 'image_file_id', "TEXT DEFAULT NULL")

  await addCol('wallet_ledger', 'note', "TEXT DEFAULT ''")
  await addCol('wallet_ledger', 'kind', "TEXT")
  await addCol('wallet_ledger', 'amount', "REAL")

  await run(`UPDATE users SET last_reset_day=? WHERE last_reset_day IS NULL`, [today()])

  // seed ad
  const c = await get(`SELECT COUNT(*) c FROM ads`)
  if ((c?.c || 0) === 0) {
    await run(
      `INSERT INTO ads(title,url,seconds,owner_user_id,expires_at,is_active,ad_type,image_file_id)
       VALUES(?,?,?,?,?,1,'LINK',NULL)`,
      ['Örnek Reklam', 'https://example.com', 10, null, now() + 999999999]
    )
  }

  console.log('✅ DB hazır (ADIM 20 - UX Sayaç + Admin)')
}

/* ================= USER ================= */
async function ensureUser(ctx) {
  const id = ctx.from.id
  let u = await get(`SELECT * FROM users WHERE user_id=?`, [id])

  if (!u) {
    await run(
      `INSERT INTO users(user_id,username,token,balance_tl,daily_ad_count,last_reset_day,referrer_id)
       VALUES(?,?,0,0,0,?,NULL)`,
      [id, ctx.from.username || '', today()]
    )
    await logEvent(id, 'USER_CREATE', `@${ctx.from.username || ''}`)
    u = await get(`SELECT * FROM users WHERE user_id=?`, [id])
  } else {
    const uname = ctx.from.username || ''
    if (uname !== (u.username || '')) await run(`UPDATE users SET username=? WHERE user_id=?`, [uname, id])
  }

  await applyReferralIfAny(ctx, id)

  // daily reset
  if ((u.last_reset_day || '') !== today()) {
    await run(`UPDATE users SET daily_ad_count=0, last_reset_day=? WHERE user_id=?`, [today(), id])
    await logEvent(id, 'DAILY_RESET', today())
  }

  return await get(`SELECT * FROM users WHERE user_id=?`, [id])
}

/* ================= UI (Genesis benzeri metin kart) ================= */
function card(u) {
  return (
`🟦 *ElmasReklam Panel*
━━━━━━━━━━━━
🪙 *ELMAS:* ${fmt4(u.token)}
💰 *TL:* ${fmt2(u.balance_tl)}
📺 *Günlük reklam:* ${u.daily_ad_count}/${DAILY_AD_LIMIT}
👥 *Referans payı:* %${REF_AD_SHARE_PCT}
━━━━━━━━━━━━
📌 1 ELMAS = ${fmt4(TOKEN_TL_PRICE)} TL`
  )
}

/* ================= MENUS (sağ-sol) ================= */
function mainMenu(ctx) {
  const rows = []

  // Telegram WebApp buttons accept ONLY HTTPS. Localhost/http will crash /start.
  if (WEBAPP_URL && WEBAPP_URL.startsWith('https://')) {
    rows.push([Markup.button.webApp('🧬 Genesis Wallet', WEBAPP_URL)])
  }

  rows.push(
    [Markup.button.callback('📺 Reklam İzle', 'AD'), Markup.button.callback('🪙 Cüzdan', 'WALLET')],
    [Markup.button.callback('💱 Market', 'MARKET'), Markup.button.callback('👥 Referans', 'REF')],
    [Markup.button.callback('💸 Para Çek', 'PAYOUT'), Markup.button.callback('👑 VIP', 'VIP')]
  )

  if (isAdmin(ctx)) {
    rows.push([Markup.button.callback('🛠 Admin Panel', 'ADMIN')])
  }

  return Markup.inlineKeyboard(rows)
}

const walletMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📥 Adresim', 'ADDR'), Markup.button.callback('🧾 Geçmiş', 'HIST')],
  [Markup.button.callback('⬅️ Menü', 'BACK')],
])

const marketMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🔁 ELMAS → TL', 'M_T2TL'), Markup.button.callback('🛒 TL → ELMAS', 'M_TL2T')],
  [Markup.button.callback('⬅️ Menü', 'BACK')],
])

const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Reklam Ekle', 'A_ADD_AD')],
  [Markup.button.callback('📋 Reklamları Listele', 'A_ADS_0')],
  [Markup.button.callback('🔎 Kullanıcı Sorgu', 'A_USERQ')],
  [Markup.button.callback('⬅️ Menü', 'BACK')],
])

/* ================= BOT ================= */
const bot = new Telegraf(BOT_TOKEN)

/* ===== START ===== */
bot.start(async (ctx) => {
  const u = await ensureUser(ctx)
  await ctx.replyWithMarkdown(card(u), mainMenu(ctx))
})

bot.action('BACK', async (ctx) => {
  if (!(await guardCooldown(ctx, 'BACK'))) return
  await ctx.answerCbQuery().catch(() => {})
  const u = await ensureUser(ctx)
  await ctx.replyWithMarkdown(card(u), mainMenu(ctx))
})

/* ===== PLACEHOLDERS ===== */
bot.action('PAYOUT', async (ctx) => {
  if (!(await guardCooldown(ctx, 'PAYOUT'))) return
  await ctx.answerCbQuery().catch(() => {})
  await ctx.reply('💸 Para çekme modülü ADIM 22’de gelecek (IBAN + admin onay).', mainMenu(ctx))
})
bot.action('VIP', async (ctx) => {
  if (!(await guardCooldown(ctx, 'VIP'))) return
  await ctx.answerCbQuery().catch(() => {})
  await ctx.reply('👑 VIP modülü ADIM 23’te gelecek (2x kazanç vb.).', mainMenu(ctx))
})

/* ================= WALLET ================= */
bot.action('WALLET', async (ctx) => {
  if (!(await guardCooldown(ctx, 'WALLET'))) return
  await ctx.answerCbQuery().catch(() => {})
  const u = await ensureUser(ctx)
  await ctx.reply(`🪙 Cüzdan\nELMAS: ${fmt4(u.token)}\nTL: ${fmt2(u.balance_tl)}`, walletMenu)
})

bot.action('ADDR', async (ctx) => {
  if (!(await guardCooldown(ctx, 'ADDR'))) return
  await ctx.answerCbQuery().catch(() => {})
  const u = await ensureUser(ctx)
  await ctx.reply(`📥 Adresin (off-chain)\n🆔 ${u.user_id}`, walletMenu)
})

bot.action('HIST', async (ctx) => {
  if (!(await guardCooldown(ctx, 'HIST'))) return
  await ctx.answerCbQuery().catch(() => {})
  const u = await ensureUser(ctx)
  const rows = await all(
    `SELECT kind, amount, note, created_at
     FROM wallet_ledger WHERE user_id=?
     ORDER BY id DESC LIMIT 15`,
    [u.user_id]
  )
  const text = rows.length
    ? rows.map(r => `${r.kind} ${(Number(r.amount) >= 0 ? '+' : '')}${fmt4(r.amount)} | ${r.note || '-'} | ${r.created_at}`).join('\n')
    : '(işlem yok)'
  await ctx.reply(`🧾 Son 15 işlem:\n${text}`, walletMenu)
})

/* ================= REF ================= */
bot.action('REF', async (ctx) => {
  if (!(await guardCooldown(ctx, 'REF'))) return
  await ctx.answerCbQuery().catch(() => {})
  const u = await ensureUser(ctx)
  const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${u.user_id}` : '(bot username alınamadı)'
  const cnt = await get(`SELECT COUNT(*) c FROM users WHERE referrer_id=?`, [u.user_id])
  await ctx.reply(
`👥 Referans
✅ Referansın reklam izledikçe, kazandığı ELMAS’ın %${REF_AD_SHARE_PCT}’i sana gelir.
👤 Referans sayın: ${cnt?.c || 0}

🔗 Linkin:
${link}`,
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menü', 'BACK')]])
  )
})

/* ================= MARKET ================= */
bot.action('MARKET', async (ctx) => {
  if (!(await guardCooldown(ctx, 'MARKET'))) return
  await ctx.answerCbQuery().catch(() => {})
  const u = await ensureUser(ctx)
  await ctx.reply(
`💱 Market
ELMAS: ${fmt4(u.token)}
TL: ${fmt2(u.balance_tl)}
Fiyat: 1 ELMAS = ${fmt4(TOKEN_TL_PRICE)} TL`,
    marketMenu
  )
})

bot.action('M_T2TL', async (ctx) => {
  if (!(await guardCooldown(ctx, 'M_T2TL'))) return
  await ctx.answerCbQuery().catch(() => {})
  await setState(ctx.from.id, 'WAIT_TOK_TO_TL', {})
  await ctx.reply('🔁 ELMAS → TL\nKaç ELMAS çevireceksin? (örn: 100)\nİptal: /cancel')
})

bot.action('M_TL2T', async (ctx) => {
  if (!(await guardCooldown(ctx, 'M_TL2T'))) return
  await ctx.answerCbQuery().catch(() => {})
  await setState(ctx.from.id, 'WAIT_TL_TO_TOK', {})
  await ctx.reply('🛒 TL → ELMAS\nKaç TL ile ELMAS alacaksın? (örn: 50)\nİptal: /cancel')
})

/* ================= ADS WATCH (Sayaç + Otomatik Ödeme) ================= */
const timers = new Map() // sessionId -> interval

function adKeyboard(ad, sessionId) {
  const rows = []
  if ((ad.ad_type || 'LINK') === 'LINK' && ad.url) rows.push([Markup.button.url('🔗 Reklama Git', ad.url)])
  rows.push([Markup.button.callback('▶️ Başlat', `AD_START_${sessionId}`)])
  rows.push([Markup.button.callback('💰 Ödemeyi Al', `AD_CLAIM_${sessionId}`)])
  rows.push([Markup.button.callback('⬅️ Menü', 'BACK')])
  return Markup.inlineKeyboard(rows)
}

bot.action('AD', async (ctx) => {
  if (!(await guardCooldown(ctx, 'AD'))) return
  await ctx.answerCbQuery().catch(() => {})

  const u = await ensureUser(ctx)
  if (u.daily_ad_count >= DAILY_AD_LIMIT) {
    return ctx.reply('🚫 Günlük reklam limitin doldu (00:00’da sıfırlanır).', mainMenu(ctx))
  }

  const ad = await get(
    `SELECT * FROM ads
     WHERE is_active=1 AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY RANDOM() LIMIT 1`,
    [now()]
  )
  if (!ad) return ctx.reply('⚠️ Şu an reklam yok. (Reklam yoksa ödeme de yok.)', mainMenu(ctx))

  const ins = await run(
    `INSERT INTO ad_sessions(user_id,ad_id,started_at,required_seconds,rewarded)
     VALUES(?,?,?,?,0)`,
    [u.user_id, ad.id, 0, ad.seconds]
  )
  const sessionId = ins.lastID
  const rewardTok = Number(ad.seconds || 0) * TOKEN_PER_SEC

  const caption =
`📺 ${ad.title}
⏱ Süre: ${ad.seconds}s
🎁 Ödül: ${fmt4(rewardTok)} ELMAS

👉 “▶️ Başlat” deyince sayaç başlar.`

  const kb = adKeyboard(ad, sessionId)

  if ((ad.ad_type || 'LINK') === 'PHOTO' && ad.image_file_id) {
    return ctx.replyWithPhoto(ad.image_file_id, { caption, reply_markup: kb.reply_markup })
  }
  return ctx.reply(caption, kb)
})

async function tryClaimSession(ctx, sessionId, auto = false) {
  const s = await get(`SELECT * FROM ad_sessions WHERE id=?`, [sessionId])
  if (!s) {
    if (!auto) await ctx.reply('⚠️ Oturum bulunamadı.', mainMenu(ctx))
    return
  }
  if (Number(s.user_id) !== Number(ctx.from.id)) {
    if (!auto) await ctx.reply('⚠️ Bu oturum senin değil.', mainMenu(ctx))
    return
  }
  if (Number(s.rewarded) === 1) {
    if (!auto) await ctx.reply('✅ Bu reklam zaten ödendi.', mainMenu(ctx))
    return
  }
  if (!Number(s.started_at)) {
    if (!auto) await ctx.reply('⏳ Önce ▶️ Başlat butonuna bas.', mainMenu(ctx))
    return
  }

  const elapsed = now() - Number(s.started_at)
  if (elapsed < Number(s.required_seconds || 0)) {
    if (!auto) await ctx.reply(`⏳ Süre dolmadı. Kalan: ${Number(s.required_seconds) - elapsed}s`, mainMenu(ctx))
    return
  }

  const u = await ensureUser(ctx)
  if (u.daily_ad_count >= DAILY_AD_LIMIT) {
    await run(`UPDATE ad_sessions SET rewarded=1 WHERE id=?`, [sessionId])
    if (!auto) await ctx.reply('🚫 Günlük limit dolmuş. Ödül verilmedi.', mainMenu(ctx))
    return
  }

  const tok = Number(s.required_seconds || 0) * TOKEN_PER_SEC

  await run(`UPDATE users SET token=token+?, daily_ad_count=daily_ad_count+1 WHERE user_id=?`, [tok, ctx.from.id])
  await run(`UPDATE ad_sessions SET rewarded=1 WHERE id=?`, [sessionId])

  await ledgerAdd(ctx.from.id, 'AD_REWARD', +tok, `${s.required_seconds}s`)
  await logEvent(ctx.from.id, 'AD_REWARD', `+${tok} TOK sid=${sessionId}`)
  await payReferralShare(ctx.from.id, tok, bot)

  const after = await get(`SELECT token, balance_tl, daily_ad_count FROM users WHERE user_id=?`, [ctx.from.id])

  await ctx.reply(
`✅ Ödül yattı!
+${fmt4(tok)} ELMAS
🪙 ${fmt4(after.token)} ELMAS | 💰 ${fmt2(after.balance_tl)} TL
📺 Bugün: ${after.daily_ad_count}/${DAILY_AD_LIMIT}`,
    mainMenu(ctx)
  )
}

bot.action(/AD_START_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const sessionId = Number(ctx.match[1])
  const s = await get(`SELECT * FROM ad_sessions WHERE id=?`, [sessionId])
  if (!s) return
  if (Number(s.user_id) !== Number(ctx.from.id)) return

  if (!Number(s.started_at)) {
    await run(`UPDATE ad_sessions SET started_at=? WHERE id=?`, [now(), sessionId])
  }

  // Timer zaten varsa tekrar açma
  if (timers.has(sessionId)) return

  let ticks = 0
  const interval = setInterval(async () => {
    ticks++
    try {
      const ss = await get(`SELECT started_at, required_seconds, rewarded FROM ad_sessions WHERE id=?`, [sessionId])
      if (!ss || Number(ss.rewarded) === 1) {
        clearInterval(interval); timers.delete(sessionId); return
      }

      const rem = Number(ss.required_seconds) - (now() - Number(ss.started_at))
      if (rem <= 0) {
        clearInterval(interval); timers.delete(sessionId)
        // otomatik ödeme
        await tryClaimSession(ctx, sessionId, true)
        return
      }

      // çok sık edit spam olmasın
      if (ticks <= MAX_TICKS) {
        await ctx.editMessageCaption?.(`⏳ Sayaç: ${rem}s\n\n(İstersen süre bitince “💰 Ödemeyi Al” da kullanabilirsin.)`).catch(() => {})
        await ctx.editMessageText?.(`⏳ Sayaç: ${rem}s\n\n(İstersen süre bitince “💰 Ödemeyi Al” da kullanabilirsin.)`).catch(() => {})
      }
      if (ticks > MAX_TICKS) {
        // fazla uzadıysa edit bırak, claim butonu var
        clearInterval(interval); timers.delete(sessionId)
      }
    } catch {
      clearInterval(interval); timers.delete(sessionId)
    }
  }, TICK_MS)

  timers.set(sessionId, interval)
})

bot.action(/AD_CLAIM_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  const sessionId = Number(ctx.match[1])
  await tryClaimSession(ctx, sessionId, false)
})

/* ================= ADMIN ================= */
bot.action('ADMIN', async (ctx) => {
  if (!(await guardCooldown(ctx, 'ADMIN'))) return
  await ctx.answerCbQuery().catch(() => {})
  if (!isAdmin(ctx)) return
  await ctx.reply('🛠 Admin Panel', adminMenu)
})

bot.action('A_ADD_AD', async (ctx) => {
  if (!(await guardCooldown(ctx, 'A_ADD_AD'))) return
  await ctx.answerCbQuery().catch(() => {})
  if (!isAdmin(ctx)) return

  await setState(ADMIN_ID, 'ADMIN_AD_TYPE', {})
  await ctx.reply(
    '➕ Reklam Ekle\nTür seç:',
    Markup.inlineKeyboard([
      [Markup.button.callback('🔗 Link Reklam', 'A_ADTYPE_LINK'), Markup.button.callback('🖼 Foto Reklam', 'A_ADTYPE_PHOTO')],
      [Markup.button.callback('⬅️ Admin', 'ADMIN')]
    ])
  )
})

bot.action('A_ADTYPE_LINK', async (ctx) => {
  if (!isAdmin(ctx)) return
  await ctx.answerCbQuery().catch(() => {})
  await setState(ADMIN_ID, 'ADMIN_AD_TITLE', { ad_type: 'LINK' })
  await ctx.reply('1) Reklam başlığı yaz:')
})

bot.action('A_ADTYPE_PHOTO', async (ctx) => {
  if (!isAdmin(ctx)) return
  await ctx.answerCbQuery().catch(() => {})
  await setState(ADMIN_ID, 'ADMIN_AD_TITLE', { ad_type: 'PHOTO' })
  await ctx.reply('1) Reklam başlığı yaz:')
})

bot.action(/A_ADS_(\d+)/, async (ctx) => {
  if (!(await guardCooldown(ctx, 'A_ADS'))) return
  await ctx.answerCbQuery().catch(() => {})
  if (!isAdmin(ctx)) return

  const page = clampInt(Number(ctx.match[1] || 0), 0, 9999)
  const offset = page * ADMIN_ADS_PAGE_SIZE

  const totalRow = await get(`SELECT COUNT(*) c FROM ads`)
  const total = totalRow?.c || 0
  const maxPage = Math.max(0, Math.ceil(total / ADMIN_ADS_PAGE_SIZE) - 1)

  const rows = await all(
    `SELECT id,title,seconds,is_active,ad_type,url,image_file_id,expires_at
     FROM ads ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [ADMIN_ADS_PAGE_SIZE, offset]
  )
  if (!rows.length) return ctx.reply('📋 Reklam yok.', adminMenu)

  let text = `📋 Reklamlar (Sayfa ${page + 1}/${maxPage + 1})\n`
  const t = now()

  for (const r of rows) {
    const active = Number(r.is_active) ? '✅' : '⛔'
    const typ = (r.ad_type || (r.image_file_id ? 'PHOTO' : 'LINK')).toUpperCase()
    const exp = r.expires_at ? (r.expires_at > t ? 'aktif' : 'EXPIRED') : 'no-exp'
    text += `\n#${r.id} ${active} [${typ}] ${r.seconds}s (${exp})\n${r.title}\n`
    if (typ === 'LINK') text += `${r.url || ''}\n`
    if (typ === 'PHOTO') text += `🖼 foto: ${r.image_file_id ? 'var' : 'yok'}\n`
    text += `—\n`
  }

  const nav = []
  if (page > 0) nav.push(Markup.button.callback('⬅️', `A_ADS_${page - 1}`))
  nav.push(Markup.button.callback('🔄', `A_ADS_${page}`))
  if (page < maxPage) nav.push(Markup.button.callback('➡️', `A_ADS_${page + 1}`))

  await ctx.reply(
    text,
    Markup.inlineKeyboard([
      nav.length ? nav : [Markup.button.callback('🔄', `A_ADS_${page}`)],
      [Markup.button.callback('🟢/🔴 Aktif-Pasif (ID)', 'A_AD_TOGGLE_ASK'), Markup.button.callback('🗑 Sil (ID)', 'A_AD_DEL_ASK')],
      [Markup.button.callback('⬅️ Admin', 'ADMIN')]
    ])
  )
})

bot.action('A_AD_TOGGLE_ASK', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  if (!isAdmin(ctx)) return
  await setState(ADMIN_ID, 'ADMIN_AD_TOGGLE_ID', {})
  await ctx.reply('Aktif/Pasif yapmak istediğin reklam ID yaz (örn: 12)')
})

bot.action('A_AD_DEL_ASK', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  if (!isAdmin(ctx)) return
  await setState(ADMIN_ID, 'ADMIN_AD_DEL_ID', {})
  await ctx.reply('Silmek istediğin reklam ID yaz (örn: 12)')
})

bot.action('A_USERQ', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {})
  if (!isAdmin(ctx)) return
  await setState(ADMIN_ID, 'ADMIN_USERQ', {})
  await ctx.reply('🔎 Kullanıcı Sorgu: User ID yaz (örn: 123456789)')
})

/* ================= PHOTO (ADMIN ADD PHOTO AD) ================= */
bot.on('photo', async (ctx) => {
  if (!isAdmin(ctx)) return
  const st = await getState(ADMIN_ID)
  if (!st || st.state !== 'ADMIN_AD_PHOTO') return

  const photos = ctx.message.photo || []
  const best = photos[photos.length - 1]
  if (!best?.file_id) return ctx.reply('❌ Foto alınamadı. Tekrar gönder.')

  const fileId = best.file_id
  const exp = now() + (7 * 24 * 3600)

  await run(
    `INSERT INTO ads(title,url,seconds,owner_user_id,expires_at,is_active,ad_type,image_file_id)
     VALUES(?,?,?,?,?,1,'PHOTO',?)`,
    [st.data.title, null, Number(st.data.seconds), ADMIN_ID, exp, fileId]
  )
  await clearState(ADMIN_ID)
  return ctx.reply('✅ Foto reklam eklendi.', adminMenu)
})

/* ================= CANCEL ================= */
bot.command('cancel', async (ctx) => {
  await clearState(ctx.from.id)
  await ctx.reply('✅ İptal edildi.', mainMenu(ctx))
})

/* ================= TEXT HANDLER (STATES) ================= */
bot.on('text', async (ctx) => {
  const st = await getState(ctx.from.id)
  if (!st) return
  const t = (ctx.message.text || '').trim()

  // ADMIN: ad add
  if (isAdmin(ctx) && st.state === 'ADMIN_AD_TITLE') {
    if (t.length < 3) return ctx.reply('❌ Başlık çok kısa. Tekrar yaz.')
    await setState(ADMIN_ID, 'ADMIN_AD_SECONDS', { ...st.data, title: t })
    return ctx.reply('2) Reklam süresi (sn) yaz. Örn: 15')
  }

  if (isAdmin(ctx) && st.state === 'ADMIN_AD_SECONDS') {
    const sec = Math.floor(toNum(t))
    if (!Number.isFinite(sec) || sec <= 0) return ctx.reply('❌ Süre hatalı.')
    if (sec > 180) return ctx.reply('❌ Max 180 sn.')
    if ((st.data.ad_type || 'LINK') === 'LINK') {
      await setState(ADMIN_ID, 'ADMIN_AD_URL', { ...st.data, seconds: sec })
      return ctx.reply('3) Reklam linki yaz (https://...)')
    } else {
      await setState(ADMIN_ID, 'ADMIN_AD_PHOTO', { ...st.data, seconds: sec })
      return ctx.reply('3) Reklam fotoğrafını gönder.')
    }
  }

  if (isAdmin(ctx) && st.state === 'ADMIN_AD_URL') {
    if (!isHttp(t)) return ctx.reply('❌ Link geçersiz. https://... olmalı.')
    const exp = now() + (7 * 24 * 3600)
    await run(
      `INSERT INTO ads(title,url,seconds,owner_user_id,expires_at,is_active,ad_type,image_file_id)
       VALUES(?,?,?,?,?,1,'LINK',NULL)`,
      [st.data.title, t, Number(st.data.seconds), ADMIN_ID, exp]
    )
    await clearState(ADMIN_ID)
    return ctx.reply('✅ Link reklam eklendi.', adminMenu)
  }

  // ADMIN: toggle/delete/userq
  if (isAdmin(ctx) && st.state === 'ADMIN_AD_TOGGLE_ID') {
    const id = Number(t.replace(/\D/g, ''))
    if (!id) return ctx.reply('❌ ID hatalı.')
    const row = await get(`SELECT is_active FROM ads WHERE id=?`, [id])
    if (!row) { await clearState(ADMIN_ID); return ctx.reply('❌ Reklam yok.', adminMenu) }
    const newVal = Number(row.is_active) ? 0 : 1
    await run(`UPDATE ads SET is_active=? WHERE id=?`, [newVal, id])
    await clearState(ADMIN_ID)
    return ctx.reply(`✅ Güncellendi. #${id} artık ${newVal ? 'AKTİF' : 'PASİF'}`, adminMenu)
  }

  if (isAdmin(ctx) && st.state === 'ADMIN_AD_DEL_ID') {
    const id = Number(t.replace(/\D/g, ''))
    if (!id) return ctx.reply('❌ ID hatalı.')
    await run(`DELETE FROM ads WHERE id=?`, [id])
    await clearState(ADMIN_ID)
    return ctx.reply(`🗑 Silindi: #${id}`, adminMenu)
  }

  if (isAdmin(ctx) && st.state === 'ADMIN_USERQ') {
    const uid = Number(t.replace(/\D/g, ''))
    if (!uid) return ctx.reply('❌ User ID hatalı.')
    await clearState(ADMIN_ID)

    const u = await get(`SELECT * FROM users WHERE user_id=?`, [uid])
    if (!u) return ctx.reply('❌ Kullanıcı yok.', adminMenu)

    const led = await all(
      `SELECT kind, amount, note, created_at
       FROM wallet_ledger WHERE user_id=?
       ORDER BY id DESC LIMIT 20`, [uid]
    )
    const logs = await all(
      `SELECT type, detail, created_at
       FROM logs WHERE user_id=?
       ORDER BY id DESC LIMIT 20`, [uid]
    )

    const ledText = led.length
      ? led.map(r => `• ${r.kind} ${(Number(r.amount)>=0?'+':'')}${fmt4(r.amount)} | ${r.note||'-'} | ${r.created_at}`).join('\n')
      : '• (yok)'
    const logText = logs.length
      ? logs.map(r => `• ${r.type} | ${r.detail||'-'} | ${r.created_at}`).join('\n')
      : '• (yok)'

    return ctx.reply(
`👤 Kullanıcı
ID: ${u.user_id}
@${u.username || '-'}
🪙 ELMAS: ${fmt4(u.token)}
💰 TL: ${fmt2(u.balance_tl)}
📺 Bugün: ${u.daily_ad_count}/${DAILY_AD_LIMIT}
👥 Referrer: ${u.referrer_id || '-'}

🧾 Ledger (20)
${ledText}

🪵 Log (20)
${logText}`,
      adminMenu
    )
  }

  // MARKET states
  if (st.state === 'WAIT_TOK_TO_TL') {
    const tok = toNum(t)
    const u = await ensureUser(ctx)
    if (!Number.isFinite(tok) || tok <= 0) return ctx.reply('❌ Hatalı miktar.')
    if (u.token < tok) return ctx.reply(`❌ ELMAS yetmiyor. Mevcut: ${fmt4(u.token)}`)
    const tl = tok * TOKEN_TL_PRICE

    await run(`UPDATE users SET token=token-?, balance_tl=balance_tl+? WHERE user_id=?`, [tok, tl, u.user_id])
    await ledgerAdd(u.user_id, 'TOK_TO_TL', -tok, `toTL=${fmt2(tl)}`)
    await logEvent(u.user_id, 'TOK_TO_TL', `-${tok} TOK +${tl} TL`)
    await clearState(u.user_id)

    const after = await get(`SELECT token,balance_tl FROM users WHERE user_id=?`, [u.user_id])
    return ctx.reply(`✅ Çevrildi!\n-${fmt4(tok)} ELMAS → +${fmt2(tl)} TL\n🪙 ${fmt4(after.token)} ELMAS | 💰 ${fmt2(after.balance_tl)} TL`, mainMenu(ctx))
  }

  if (st.state === 'WAIT_TL_TO_TOK') {
    const tl = toNum(t)
    const u = await ensureUser(ctx)
    if (!Number.isFinite(tl) || tl <= 0) return ctx.reply('❌ Hatalı miktar.')
    if (u.balance_tl < tl) return ctx.reply(`❌ TL yetmiyor. Mevcut: ${fmt2(u.balance_tl)} TL`)
    const tok = tl / TOKEN_TL_PRICE

    await run(`UPDATE users SET balance_tl=balance_tl-?, token=token+? WHERE user_id=?`, [tl, tok, u.user_id])
    await ledgerAdd(u.user_id, 'TL_TO_TOK', +tok, `spentTL=${fmt2(tl)}`)
    await logEvent(u.user_id, 'TL_TO_TOK', `-${tl} TL +${tok} TOK`)
    await clearState(u.user_id)

    const after = await get(`SELECT token,balance_tl FROM users WHERE user_id=?`, [u.user_id])
    return ctx.reply(`✅ Alındı!\n-${fmt2(tl)} TL → +${fmt4(tok)} ELMAS\n🪙 ${fmt4(after.token)} ELMAS | 💰 ${fmt2(after.balance_tl)} TL`, mainMenu(ctx))
  }
})

/* ================= SAFETY ================= */
process.on('unhandledRejection', e => console.log('❌ unhandledRejection:', e))
process.on('uncaughtException', e => console.log('❌ uncaughtException:', e))

/* ================= START APP ================= */
initDb().then(async () => {
  try {
    const me = await bot.telegram.getMe()
    BOT_USERNAME = me?.username || ''
    console.log('✅ Bot username:', BOT_USERNAME)
  } catch {}

  bot.launch()
  console.log('🚀 Bot çalışıyor (ADIM 20)')
}).catch(e => console.log('❌ init error:', e))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

// ================= WEBAPP SERVER =================
try {
  require('./webapp-server.cjs')
  console.log('✅ WebApp server başlatıldı')
} catch (e) {
  console.log('⚠️ WebApp server başlatılamadı:', e.message)
}
