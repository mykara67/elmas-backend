// web-server.cjs
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Render ENV'de olacak
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Basit reklam sayfası
app.get("/ad/:nonce", async (req, res) => {
  const { nonce } = req.params;

  // nonce var mı kontrol
  const { data: view, error } = await supabase
    .from("ad_views")
    .select("id, ad_id, status")
    .eq("nonce", nonce)
    .maybeSingle();

  if (error || !view) {
    return res.status(404).send("Ad view not found.");
  }

  // Reklam bilgisini çek
  const { data: ad } = await supabase
    .from("ads")
    .select("id,title,url,seconds,reward,is_active,is_vip")
    .eq("id", view.ad_id)
    .maybeSingle();

  if (!ad || ad.is_active !== true) {
    return res.status(404).send("Ad not active.");
  }

  // Basit HTML + sayaç
  // AdSense'i buraya SONRA ekleyeceğiz (şimdilik placeholder)
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${ad.title ?? "Reklam"}</title>
  <style>
    body{font-family:Arial;background:#0b1220;color:#fff;margin:0;padding:18px}
    .card{max-width:720px;margin:0 auto;background:#121a2b;border-radius:16px;padding:16px}
    .btn{display:inline-block;padding:12px 14px;background:#2d6cdf;color:#fff;border-radius:12px;text-decoration:none;margin-top:10px}
    .muted{opacity:.8}
    .timer{font-size:20px;margin:12px 0}
    iframe{width:100%;height:360px;border:0;border-radius:12px;background:#000}
  </style>
</head>
<body>
  <div class="card">
    <h2>${ad.title ?? "Reklam"}</h2>
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
  const tEl = document.getElementById("t");
  const doneEl = document.getElementById("done");

  function tick(){
    tEl.textContent = left;
    left--;
    if(left < 0){
      doneEl.style.display = "block";
      fetch("/complete/${nonce}", { method:"POST" }).catch(()=>{});
      return;
    }
    setTimeout(tick, 1000);
  }
  tick();
</script>
</body>
</html>
  `);
});

// Sayaç bittiğinde onay endpointi
app.post("/complete/:nonce", async (req, res) => {
  const { nonce } = req.params;

  const { data: view, error } = await supabase
    .from("ad_views")
    .select("id,status")
    .eq("nonce", nonce)
    .maybeSingle();

  if (error || !view) return res.status(404).json({ ok: false });

  if (view.status === "completed") return res.json({ ok: true });

  const { error: upErr } = await supabase
    .from("ad_views")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", view.id);

  if (upErr) return res.status(500).json({ ok: false });
  res.json({ ok: true });
});

app.get("/health", (req,res)=>res.send("ok"));

app.listen(PORT, () => console.log("web listening on", PORT));
