// web-server.cjs (CommonJS) - Render Web Service
// Serves /ad/:sessionId page as Telegram WebApp (Mini App)
// Verifies completion via Telegram initData (signed), then bot credits user via web_app_data.

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN; // needed to verify Telegram initData

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ENV');
}
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in ENV (required to verify Telegram WebApp initData)');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Serve static Telegram Mini App UI ---
// This fixes: "Cannot GET /webapp/" and "Cannot GET /webapp/watch.html"
// Make sure your repo has: ./webapp/index.html (and optionally watch.html, app.js, style.css, etc.)
app.use('/webapp', express.static(path.join(__dirname, 'webapp')));

app.get(['/webapp', '/webapp/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});

app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// --- Telegram WebApp initData verification ---
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function parseInitData(initData) {
  const params = new URLSearchParams(initData || '');
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, error: 'missing_initData_or_token' };

  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return { ok: false, error: 'missing_hash' };

  // Build data_check_string (sorted, exclude hash)
  const pairs = Object.keys(data)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${data[k]}`);

  const dataCheckString = pairs.join('\n');
  const secretKey = sha256(botToken);
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (hmac !== hash) return { ok: false, error: 'bad_hash' };

  let user = null;
  try {
    user = data.user ? JSON.parse(data.user) : null;
  } catch {
    user = null;
  }

  return { ok: true, data, user };
}

// --- Helpers ---
async function getSessionAndAd(sessionId) {
  const { data: s, error: se } = await supabase
    .from('ad_sessions')
    .select('id,user_id,ad_id,seconds,reward_tl,reward_elmas,status,created_at,completed_at,paid_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (se || !s) return { error: se || new Error('session_not_found') };

  const { data: ad, error: ae } = await supabase
    .from('ads')
    .select('id,title,url,seconds,reward_tl,reward_elmas,is_active')
    .eq('id', s.ad_id)
    .maybeSingle();

  if (ae || !ad) return { error: ae || new Error('ad_not_found') };

  // prefer session overrides
  const merged = {
    session: s,
    ad: {
      ...ad,
      seconds: Number(s.seconds ?? ad.seconds ?? 15),
      reward_tl: Number(s.reward_tl ?? ad.reward_tl ?? 0),
      reward_elmas: Number(s.reward_elmas ?? ad.reward_elmas ?? 0),
    },
  };

  return merged;
}

// MiniApp ad page
app.get('/ad/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;

  const info = await getSessionAndAd(sessionId);
  if (info.error) {
    return res.status(404).send('Session not found');
  }

  const { session, ad } = info;

  // If completed, show success message
  const isDone = session.status === 'completed' || !!session.completed_at;

  const title = ad.title || 'Reklam';
  const seconds = Math.max(1, Number(ad.seconds || 15));
  const rewardTL = Number(ad.reward_tl || 0).toFixed(2);
  const rewardELMAS = Number(ad.reward_elmas || 0).toFixed(2);

  const videoUrl = (ad.url || '').trim();
  const escapedUrl = videoUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root{--bg:#071226;--panel:#0b1b35;--card:#0f2344;--text:#eaf2ff;--muted:#9db0d0;--bad:#ff4d4d;--good:#2ecc71;}
    body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
    .wrap{max-width:980px;margin:0 auto;padding:18px;}
    .top{display:flex;gap:12px;align-items:center;justify-content:space-between;}
    .badge{background:rgba(255,255,255,.06);padding:10px 14px;border-radius:14px;font-weight:700;}
    .sub{color:var(--muted);margin-top:4px;font-size:13px;}
    .card{margin-top:14px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:14px;}
    .video{position:relative;border-radius:14px;overflow:hidden;background:#111;}
    video{width:100%;height:auto;display:block;}
    .timer{position:absolute;left:12px;top:12px;background:rgba(0,0,0,.6);padding:10px 12px;border-radius:12px;font-weight:800;}
    .row{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;}
    .msg{margin-top:10px;color:var(--muted);font-size:13px;}
    .err{margin-top:10px;color:var(--bad);font-weight:700;}
    .ok{margin-top:10px;color:var(--good);font-weight:800;}
    .btn{display:inline-flex;align-items:center;gap:8px;background:#1b3c7a;color:#fff;border:0;padding:12px 14px;border-radius:14px;font-weight:800;cursor:pointer;}
    .btn:disabled{opacity:.55;cursor:not-allowed;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <div style="font-size:20px;font-weight:900">${title}</div>
        <div class="sub">Süre dolmadan ödül verilmez. Sayfayı kapatma.</div>
      </div>
      <div class="badge">Ödül: ${rewardTL} TL + ${rewardELMAS} ELMAS</div>
    </div>

    <div class="card">
      <div class="video">
        <div class="timer" id="timer">Hazır</div>
        <video id="vid" controls playsinline preload="metadata" ${videoUrl ? `src="${escapedUrl}"` : ''}></video>
      </div>

      <div class="msg" id="help">
        1) Videoyu oynat ▶️ (play)
        &nbsp;•&nbsp; 2) Video izlenirken sayaç çalışır.
        &nbsp;•&nbsp; 3) Süre dolunca otomatik ödül onayı yapılır.
      </div>
      <div class="err" id="err" style="display:none"></div>
      <div class="ok" id="ok" style="display:none"></div>

      <div style="margin-top:12px" class="row">
        <button class="btn" id="forceBtn" disabled>✅ Süre doldu → Ödülü Onayla</button>
      </div>
    </div>
  </div>

<script>
(function(){
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) {
    try { tg.ready(); } catch(e) {}
  }

  const SESSION_ID = ${JSON.stringify(sessionId)};
  const REQUIRED = ${JSON.stringify(seconds)};
  const alreadyDone = ${JSON.stringify(Boolean(isDone))};

  const timerEl = document.getElementById('timer');
  const errEl = document.getElementById('err');
  const okEl = document.getElementById('ok');
  const btn = document.getElementById('forceBtn');
  const vid = document.getElementById('vid');

  function showErr(msg){ errEl.textContent = msg; errEl.style.display='block'; }
  function clearErr(){ errEl.style.display='none'; errEl.textContent=''; }
  function showOk(msg){ okEl.textContent = msg; okEl.style.display='block'; }

  if (alreadyDone) {
    timerEl.textContent = 'Tamamlandı';
    btn.disabled = true;
    showOk('✅ Bu reklam zaten tamamlanmış. Telegram’a dönebilirsin.');
    return;
  }

  // Safety: if no video URL, block
  if (!vid.getAttribute('src')) {
    timerEl.textContent = 'Video yok';
    showErr('❌ Video linki yok. ads.url alanına direkt .mp4 linki koy.');
    return;
  }

  let started = false;
  let lastTs = 0;
  let watched = 0; // seconds
  let ticking = false;

  function render(){
    const left = Math.max(0, Math.ceil(REQUIRED - watched));
    timerEl.textContent = 'Kalan: ' + left + ' sn';
    if (left <= 0) {
      btn.disabled = false;
      btn.textContent = '✅ Süre doldu → Ödül Onayla';
    }
  }

  function tick(now){
    if (!ticking) return;
    if (!started) { lastTs = now; requestAnimationFrame(tick); return; }

    const dt = (now - lastTs) / 1000;
    lastTs = now;

    // Only count when video is actually playing + page visible
    const playing = !vid.paused && !vid.ended && vid.readyState >= 2;
    const visible = document.visibilityState === 'visible';

    if (playing && visible) {
      // cap dt to avoid huge jumps
      watched += Math.min(0.25, Math.max(0, dt));
      if (watched >= REQUIRED) {
        watched = REQUIRED;
        ticking = false;
        render();
        autoComplete();
        return;
      }
      render();
    }

    requestAnimationFrame(tick);
  }

  function startWatch(){
    if (started) return;
    started = true;
    ticking = true;
    lastTs = performance.now();
    clearErr();
    render();
    requestAnimationFrame(tick);
  }

  vid.addEventListener('play', startWatch);

  // If user pauses, timer stops automatically.

  btn.addEventListener('click', () => {
    if (watched < REQUIRED) return;
    autoComplete();
  });

  async function autoComplete(){
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '⏳ Onaylanıyor...';

    try {
      if (!tg) throw new Error('Telegram WebApp bulunamadı. (Sayfayı Telegram içinden aç)');

      // initData is signed by Telegram (we verify on server)
      const initData = tg.initData || '';
      if (!initData) throw new Error('initData yok. (Sayfayı Telegram WebApp olarak açmalısın)');

      const r = await fetch('/api/ad/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, initData })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        throw new Error(j.error || 'Ödül onayı başarısız');
      }

      // Notify bot via web_app_data
      tg.sendData(JSON.stringify({ type: 'ad_complete', sessionId: SESSION_ID }));
      showOk('✅ Onay gönderildi. Telegram sohbetine dön → ödül verilecek.');

      // Optional: close after a short delay
      setTimeout(() => { try { tg.close(); } catch(e) {} }, 800);

    } catch (e) {
      showErr('❌ ' + (e && e.message ? e.message : String(e)));
      btn.disabled = false;
      btn.textContent = '✅ Süre doldu → Ödül Onayla';
    }
  }

  // Initial UI
  timerEl.textContent = 'Play ▶️ ile başla';
  btn.textContent = '⏳ Önce videoyu oynat';
  btn.disabled = true;
})();
</script>
</body>
</html>`;

  res.status(200).set('content-type', 'text/html; charset=utf-8').send(html);
});

// Called by WebApp page when time is completed
app.post('/api/ad/complete', async (req, res) => {
  try {
    const { sessionId, initData } = req.body || {};
    if (!sessionId || !initData) {
      return res.status(400).json({ ok: false, error: 'missing_sessionId_or_initData' });
    }

    const v = verifyTelegramInitData(initData, BOT_TOKEN);
    if (!v.ok) {
      return res.status(401).json({ ok: false, error: v.error });
    }

    const userId = v.user && v.user.id ? String(v.user.id) : null;
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'missing_user' });
    }

    const info = await getSessionAndAd(sessionId);
    if (info.error) {
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    }

    const { session, ad } = info;

    if (String(session.user_id) !== String(userId)) {
      return res.status(403).json({ ok: false, error: 'user_mismatch' });
    }

    if (session.paid_at) {
      return res.status(200).json({ ok: true, alreadyPaid: true });
    }

    // Server-side minimum time gate: require wall-clock time since created_at >= required seconds
    const required = Math.max(1, Number(ad.seconds || session.seconds || 15));
    const createdAt = session.created_at ? new Date(session.created_at).getTime() : 0;
    if (!createdAt) {
      return res.status(400).json({ ok: false, error: 'session_missing_created_at' });
    }

    const now = Date.now();
    const elapsed = (now - createdAt) / 1000;

    if (elapsed < required) {
      return res.status(400).json({ ok: false, error: 'too_early' });
    }

    // Mark completed (bot will pay when it receives web_app_data)
    if (session.status !== 'completed') {
      const { error: ue } = await supabase
        .from('ad_sessions')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', sessionId);

      if (ue) {
        return res.status(500).json({ ok: false, error: 'db_update_failed' });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('/api/ad/complete error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});
