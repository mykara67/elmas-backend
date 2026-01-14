const tg = window.Telegram?.WebApp
if (tg) tg.ready()

const elmasEl = document.getElementById('elmas')
const tlEl = document.getElementById('tl')
const userLine = document.getElementById('userLine')
const packagesEl = document.getElementById('packages')
const myadsEl = document.getElementById('myads')
const packageSelect = document.getElementById('packageSelect')
const typeSelect = document.getElementById('typeSelect')
const titleInput = document.getElementById('titleInput')
const linkInput = document.getElementById('linkInput')
const photoInput = document.getElementById('photoInput')
const linkWrap = document.getElementById('linkWrap')
const photoWrap = document.getElementById('photoWrap')
const statusEl = document.getElementById('status')

document.getElementById('btnClose').onclick = () => tg?.close()

typeSelect.onchange = () => {
  const t = typeSelect.value
  linkWrap.style.display = t === 'LINK' ? 'block' : 'none'
  photoWrap.style.display = t === 'PHOTO' ? 'block' : 'none'
}

async function api(path, body = {}) {
  // initData: Telegram tarafından verilir
  const initData = tg?.initData || ''
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-initdata': initData
    },
    body: JSON.stringify({ ...body })
  })
  return res.json()
}

function fmt(n) {
  const x = Number(n || 0)
  return x.toLocaleString('tr-TR', { maximumFractionDigits: 6 })
}

function renderPackages(pkgs) {
  packagesEl.innerHTML = ''
  packageSelect.innerHTML = ''
  pkgs.forEach(p => {
    const div = document.createElement('div')
    div.className = 'item'
    div.innerHTML = `
      <div class="meta">
        <div class="name">${p.name}</div>
        <div class="desc">Fiyat: ${fmt(p.price_elmas)} ELMAS • Süre: ${p.duration_days} gün • Limit: ${p.max_views} gösterim</div>
      </div>
      <div class="badge">Aktif</div>
    `
    packagesEl.appendChild(div)

    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = `${p.name} (${fmt(p.price_elmas)} ELMAS)`
    packageSelect.appendChild(opt)
  })
}

function renderMyAds(ads) {
  myadsEl.innerHTML = ''
  if (!ads.length) {
    myadsEl.innerHTML = `<div class="tiny">Henüz reklamın yok.</div>`
    return
  }
  ads.forEach(a => {
    const div = document.createElement('div')
    div.className = 'item'
    const exp = new Date(a.expires_at).toLocaleString('tr-TR')
    div.innerHTML = `
      <div class="meta">
        <div class="name">#${a.id} • ${a.type} • ${a.is_active ? 'Aktif' : 'Pasif'}</div>
        <div class="desc">${a.title || '(başlıksız)'} • Views: ${a.views}/${a.max_views} • Exp: ${exp}</div>
      </div>
      <div class="badge">${a.clicks} tık</div>
    `
    myadsEl.appendChild(div)
  })
}

async function loadAll() {
  statusEl.textContent = ''
  const me = await api('/api/me')
  if (!me.ok) {
    userLine.textContent = 'Giriş doğrulanamadı (initData)'
    return
  }

  userLine.textContent = `${me.user.first_name || ''} (@${me.user.username || '-'}) • id:${me.user.id}`
  elmasEl.textContent = fmt(me.balances?.elmas_balance)
  tlEl.textContent = fmt(me.balances?.tl_balance)

  const pk = await api('/api/packages')
  if (pk.ok) renderPackages(pk.packages)

  const ads = await api('/api/myAds')
  if (ads.ok) renderMyAds(ads.ads)
}

document.getElementById('btnCreate').onclick = async () => {
  statusEl.textContent = 'İşleniyor…'
  const body = {
    packageId: Number(packageSelect.value),
    type: typeSelect.value,
    title: titleInput.value.trim(),
    link: linkInput.value.trim(),
    photo_file_id: photoInput.value.trim()
  }

  const r = await api('/api/createUserAd', body)
  if (!r.ok) {
    statusEl.textContent = `❌ ${r.error || 'Hata'}`
    return
  }
  statusEl.textContent = `✅ Reklam oluşturuldu: #${r.adId}`
  await loadAll()
}

loadAll()
