// web-server.cjs (CommonJS)
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Render ENV

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Basit reklam sayfasi
app.get('/ad/:nonce', async (req, res) => {
  try {
    const { nonce } = req.params;

    const { data: view, error: vErr } = await supabase
      .from('ad_views')
      .select('id, ad_id, status')
      .eq('nonce', nonce)
      .maybeSingle();

    if (vErr || !view) return res.status(404).send('Ad view not found.');

    const { data: ad, error: aErr } = await supabase
      .from('ads')
      .select('id,title,url,seconds,reward,is_active,is_vip')
      .eq('id', view.ad_id)
      .maybeSingle();

    if (aErr || !ad || ad.is_active !== true) return res.status(404).send('Ad not active.');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${ad.title ?? 'Reklam'}</title>
  <style>
    body{font-family:Arial;background:#0b1220;color:#fff;margin:0;padding:18px}
    .card{max-width:720px;margin:0 auto;background:#121a2b;border-radius:16px;padding:16px}
    .muted{opacity:.8}
    .timer{font-size:20px;margin:12px 0}
    iframe{width:100%;height:360px;border:0;border-radius:12px;background:#000}
  </style>
</head>
<body>
  <div class="card">
    <h2>${ad.title ?? 'Reklam'}</h2>
    <div class="muted">Süre bitmeden ödül yok. Sayfayı kapatma.</div>

    <div class="timer">Kalan süre: <b id="t">--</b> sn</div>

    <!-- Reklam içeriği (şimdilik linki iframe ile açıyoruz) -->
    <iframe src="${ad.url}"></iframe>

    <div id="done" style="display:none;margin-top:12px">
      ✅ Süre doldu. Ödül almaya hak kazandın.
    </div>

    <div class="muted" style="margin-top:10px">
      Bu sayfa sayaç bitince otomatik onay gönderir.
    </div>
  </div>

<script>
  const seconds = Math.max(10, Number(${ad.seconds ?? 10}));
  let left = seconds;
  const tEl = document.getElementById('t');
  const doneEl = document.getElementById('done');

  async function complete(){
    try{ await fetch('/complete/${nonce}', { method:'POST' }); }catch(e){}
  }

  function tick(){
    tEl.textContent = left;
    left--;
    if(left < 0){
      doneEl.style.display = 'block';
      complete();
      return;
    }
    setTimeout(tick, 1000);
  }
  tick();
</script>
</body>
</html>
    `);
  } catch (e) {
    console.error('GET /ad/:nonce error', e);
    res.status(500).send('Server error');
  }
});

// Sayaç bittiğinde onay endpointi
app.post('/complete/:nonce', async (req, res) => {
  try {
    const { nonce } = req.params;

    const { data: view, error: vErr } = await supabase
      .from('ad_views')
      .select('id,status')
      .eq('nonce', nonce)
      .maybeSingle();

    if (vErr || !view) return res.status(404).json({ ok: false });
    if (view.status === 'completed') return res.json({ ok: true });

    const { error: upErr } = await supabase
      .from('ad_views')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', view.id);

    if (upErr) return res.status(500).json({ ok: false });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /complete/:nonce error', e);
    res.status(500).json({ ok: false });
  }
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log('web listening on', PORT));
