(() => {
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  const el = (id) => document.getElementById(id);

  const pill = el('pillStatus');
  const userName = el('userName');
  const balElmas = el('balElmas');
  const balTl = el('balTl');
  const rateLine = el('rateLine');
  const packagesEl = el('packages');
  const myAdsEl = el('myAds');
  const selPkg = el('selPkg');
  const selType = el('selType');
  const inpTitle = el('inpTitle');
  const inpLink = el('inpLink');
  const inpPhoto = el('inpPhoto');
  const rowLink = el('rowLink');
  const rowPhoto = el('rowPhoto');
  const btnCreate = el('btnCreate');
  const btnRefresh = el('btnRefresh');
  const status = el('status');

  const fmt4 = (n) => (Number(n || 0)).toFixed(4);

  function setPill(text, kind) {
    pill.textContent = text;
    pill.style.borderColor =
      kind === 'good' ? 'rgba(34,197,94,.25)' :
      kind === 'warn' ? 'rgba(245,158,11,.25)' :
      kind === 'bad' ? 'rgba(239,68,68,.25)' :
      'rgba(255,255,255,.10)';
    pill.style.color =
      kind === 'good' ? '#bbf7d0' :
      kind === 'warn' ? '#fde68a' :
      kind === 'bad' ? '#fecaca' :
      '';
  }

  function setStatus(msg, kind) {
    status.textContent = msg || '';
    status.style.color =
      kind === 'good' ? '#bbf7d0' :
      kind === 'warn' ? '#fde68a' :
      kind === 'bad' ? '#fecaca' :
      '';
  }

  function initTelegram() {
    if (!tg) {
      setPill('Telegram içinde aç', 'warn');
      setStatus('Bu sayfa Telegram WebApp içinden açılınca çalışır.', 'warn');
      return { ok: false, initData: '' };
    }
    tg.expand();
    try { tg.ready(); } catch {}
    const initData = tg.initData || '';
    if (!initData) {
      setPill('initData yok', 'bad');
      setStatus('Telegram içinden açmayı dene (/start → Genesis Wallet).', 'bad');
      return { ok: false, initData: '' };
    }
    return { ok: true, initData };
  }

  async function api(path, initData, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = data.error || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  function renderPackages(list) {
    if (!Array.isArray(list) || list.length === 0) {
      packagesEl.innerHTML = '<div class="skeleton">Aktif paket bulunamadı.</div>';
      selPkg.innerHTML = '';
      return;
    }

    packagesEl.innerHTML = '';
    selPkg.innerHTML = '';
    list.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml(p.name || ('Paket #' + p.id))}</div>
          <div class="badge good">${fmt4(p.price_token)} ELMAS</div>
        </div>
        <div class="itemSub">Limit: ${Number(p.views || p.ad_limit || 0)} görüntülenme</div>
      `;
      packagesEl.appendChild(div);

      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} • ${fmt4(p.price_token)} ELMAS`;
      selPkg.appendChild(opt);
    });
  }

  function renderMyAds(list) {
    if (!Array.isArray(list) || list.length === 0) {
      myAdsEl.innerHTML = '<div class="skeleton">Henüz reklam yok.</div>';
      return;
    }
    myAdsEl.innerHTML = '';
    list.forEach((a) => {
      const div = document.createElement('div');
      div.className = 'item';
      const badge = a.is_active ? 'good' : 'bad';
      const badgeTxt = a.is_active ? 'Aktif' : 'Pasif';
      const detail = a.type === 'PHOTO'
        ? (a.photo_url || '')
        : (a.link_url || '');
      div.innerHTML = `
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml(a.title || ('Reklam #' + a.id))}</div>
          <div class="badge ${badge}">${badgeTxt}</div>
        </div>
        <div class="itemSub">${escapeHtml(detail)}</div>
      `;
      myAdsEl.appendChild(div);
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  async function loadAll(initData) {
    setPill('Yükleniyor…', 'warn');
    setStatus('', '');

    // Load me
    const me = await api('/api/me', initData);
    const u = me.user || {};
    const b = me.balances || {};

    userName.textContent = (u.username ? '@' + u.username : (u.first_name || 'Kullanıcı'));
    balElmas.textContent = fmt4(b.token);
    balTl.textContent = fmt4(b.tl);
    rateLine.textContent = `1 ELMAS = ${fmt4(b.token_tl_price || 0.0001)} TL`;

    // Packages
    const pk = await api('/api/packages', initData);
    renderPackages(pk.packages || []);

    // My ads
    const my = await api('/api/my-ads', initData);
    renderMyAds(my.ads || []);

    setPill('Bağlandı', 'good');
  }

  async function createAd(initData) {
    const package_id = Number(selPkg.value || 0);
    const type = String(selType.value || 'LINK').toUpperCase();
    const title = (inpTitle.value || '').trim();
    const link_url = (inpLink.value || '').trim();
    const photo_url = (inpPhoto.value || '').trim();

    if (!package_id) throw new Error('Paket seç');
    if (type === 'LINK') {
      if (!/^https?:\/\//i.test(link_url)) throw new Error('Link URL https:// ile başlamalı');
    } else {
      if (!/^https?:\/\//i.test(photo_url)) throw new Error('Foto URL https:// ile başlamalı');
    }

    setStatus('İşleniyor…', 'warn');
    const res = await api('/api/create-ad', initData, {
      method: 'POST',
      body: { package_id, type, title, link_url, photo_url }
    });

    setStatus('✅ Reklam oluşturuldu!', 'good');

    // Update balances fast
    if (res.balances) {
      balElmas.textContent = fmt4(res.balances.token);
      balTl.textContent = fmt4(res.balances.tl);
    }

    // Reload lists
    await loadAll(initData);
  }

  function bindUI(initData) {
    selType.addEventListener('change', () => {
      const t = String(selType.value || 'LINK').toUpperCase();
      rowLink.style.display = t === 'LINK' ? '' : 'none';
      rowPhoto.style.display = t === 'PHOTO' ? '' : 'none';
    });

    btnRefresh.addEventListener('click', async () => {
      try {
        await loadAll(initData);
      } catch (e) {
        setPill('Hata', 'bad');
        setStatus(e.message || 'Hata', 'bad');
      }
    });

    btnCreate.addEventListener('click', async () => {
      try {
        await createAd(initData);
      } catch (e) {
        setStatus('❌ ' + (e.message || 'Hata'), 'bad');
      }
    });
  }

  // Boot
  (async () => {
    const t = initTelegram();
    if (!t.ok) return;

    bindUI(t.initData);

    try {
      await loadAll(t.initData);
    } catch (e) {
      setPill('Hata', 'bad');
      setStatus('❌ ' + (e.message || 'Hata'), 'bad');
    }
  })();
})();
