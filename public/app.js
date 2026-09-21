(() => {
  'use strict';

  const THEME_KEY = 'pinpoint.theme';
  const PALETTE = ['#ff6b81', '#ff9f6b', '#ffcf6b', '#8bd17c', '#6bc5ff', '#a78bff', '#ff8bc6', '#6be0d0'];
  const clientId = crypto.randomUUID();

  const state = {
    code: null,
    mapName: '',
    pins: [],
    identity: null, // { name, color }
    ws: null,
  };

  let map = null;
  let markers = new Map(); // id -> L.Marker
  let activeId = null; // pin id currently open in modal (edit) or null (new)
  let pendingLatLng = null;

  // ---------- identity persistence (per map code) ----------
  function identityKey(code) {
    return `pinpoint.identity.${code}`;
  }
  function loadIdentity(code) {
    try {
      const raw = localStorage.getItem(identityKey(code));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function saveIdentity(code, identity) {
    localStorage.setItem(identityKey(code), JSON.stringify(identity));
  }

  // ---------- color pickers ----------
  function buildColorPicker(container, onSelect) {
    container.innerHTML = '';
    let selected = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    PALETTE.forEach((color) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch' + (color === selected ? ' selected' : '');
      btn.style.background = color;
      btn.addEventListener('click', () => {
        container.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
        btn.classList.add('selected');
        selected = color;
        onSelect(color);
      });
      container.appendChild(btn);
    });
    onSelect(selected);
    return () => selected;
  }

  let getCreateColor = () => PALETTE[0];
  let getJoinColor = () => PALETTE[0];

  document.addEventListener('DOMContentLoaded', () => {
    getCreateColor = buildColorPicker(document.getElementById('createColorPicker'), () => {});
    getJoinColor = buildColorPicker(document.getElementById('joinColorPicker'), () => {});
  });

  // ---------- landing: tabs ----------
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.tab');
    if (!tabBtn) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tabBtn));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById(tabBtn.dataset.tab + 'Form').classList.add('active');
    hideLandingError();
  });

  function showLandingError(msg) {
    const el = document.getElementById('landingError');
    el.textContent = msg;
    el.hidden = false;
  }
  function hideLandingError() {
    document.getElementById('landingError').hidden = true;
  }

  // ---------- create / join ----------
  document.getElementById('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideLandingError();
    const mapName = document.getElementById('createMapName').value.trim();
    const yourName = document.getElementById('createYourName').value.trim();
    if (!mapName || !yourName) return;
    const identity = { name: yourName, color: getCreateColor() };
    try {
      const res = await fetch('/api/maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: mapName }),
      });
      if (!res.ok) throw new Error('create failed');
      const created = await res.json();
      saveIdentity(created.code, identity);
      await enterMap(created.code, identity);
    } catch {
      showLandingError("Couldn't create the map right now. Please try again.");
    }
  });

  document.getElementById('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideLandingError();
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    const yourName = document.getElementById('joinYourName').value.trim();
    if (!code || !yourName) return;
    const identity = { name: yourName, color: getJoinColor() };
    saveIdentity(code, identity);
    await enterMap(code, identity);
  });

  // ---------- entering / leaving a map ----------
  async function enterMap(code, identity) {
    code = code.toUpperCase();
    try {
      const res = await fetch(`/api/maps/${code}`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();

      state.code = data.code;
      state.mapName = data.name;
      state.pins = data.pins;
      state.identity = identity;

      history.pushState({}, '', `/m/${data.code}`);
      showMapApp();
      connectSocket(data.code);
    } catch {
      // Switch to the join tab so the person can retry the code.
      document.querySelector('.tab[data-tab="join"]').click();
      document.getElementById('joinCode').value = code;
      showLandingError("Couldn't find that map — double-check the code and try again.");
    }
  }

  function leaveMap() {
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
    state.ws = null;
    state.code = null;
    state.pins = [];
    for (const m of markers.values()) map.removeLayer(m);
    markers.clear();
    history.pushState({}, '', '/');
    document.getElementById('mapApp').hidden = true;
    document.getElementById('landing').hidden = false;
  }

  function showMapApp() {
    document.getElementById('landing').hidden = true;
    document.getElementById('mapApp').hidden = false;
    document.getElementById('mapTitle').textContent = state.mapName || 'PinPoint';
    document.getElementById('mapCodeText').textContent = state.code;
    document.title = `${state.mapName} · PinPoint`;

    if (!map) initMap();
    else map.invalidateSize();

    renderAll();
    setTimeout(() => map && map.invalidateSize(), 50);
  }

  document.getElementById('leaveBtn').addEventListener('click', leaveMap);

  document.getElementById('mapCodeChip').addEventListener('click', async () => {
    const url = `${location.origin}/m/${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Invite link copied! 💌');
    } catch {
      showToast(`Share this code: ${state.code}`);
    }
  });

  // ---------- map ----------
  function initMap() {
    map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2.4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (e) => {
      pendingLatLng = e.latlng;
      openModal(null);
    });
  }

  function pinIcon(pin) {
    const initial = (pin.authorName || '?').trim().charAt(0).toUpperCase() || '?';
    return L.divIcon({
      className: 'pin-marker-wrapper',
      html: `<div class="pin-marker">
               <div class="pin-body" style="background:${pin.authorColor}"></div>
               <div class="pin-initial">${initial}</div>
             </div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -28],
    });
  }

  // ---------- websocket ----------
  function connectSocket(code) {
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', code, clientId }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pin:created') {
        upsertPinLocal(msg.pin);
        showToast(`${msg.pin.authorName} pinned ${msg.pin.name} 💕`);
      } else if (msg.type === 'pin:updated') {
        upsertPinLocal(msg.pin);
      } else if (msg.type === 'pin:deleted') {
        removePinLocal(msg.id);
      }
    });
    ws.addEventListener('close', () => {
      if (state.code === code) setTimeout(() => connectSocket(code), 2000);
    });
    state.ws = ws;
  }

  // ---------- local state helpers ----------
  function upsertPinLocal(pin) {
    const idx = state.pins.findIndex((p) => p.id === pin.id);
    if (idx >= 0) state.pins[idx] = pin;
    else state.pins.push(pin);
    renderAll();
  }
  function removePinLocal(id) {
    state.pins = state.pins.filter((p) => p.id !== id);
    renderAll();
    if (activeId === id) closeModal();
  }

  // ---------- remote CRUD ----------
  async function createPinRemote(data) {
    const res = await fetch(`/api/maps/${state.code}/pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, clientId }),
    });
    if (!res.ok) return;
    const pin = await res.json();
    upsertPinLocal(pin);
    activeId = pin.id;
  }

  async function updatePinRemote(id, data) {
    const res = await fetch(`/api/maps/${state.code}/pins/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, clientId }),
    });
    if (!res.ok) return;
    const pin = await res.json();
    upsertPinLocal(pin);
  }

  async function deletePinRemote(id) {
    await fetch(`/api/maps/${state.code}/pins/${id}?clientId=${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
    });
    removePinLocal(id);
  }

  // ---------- rendering ----------
  function renderAll() {
    renderMarkers();
    renderSidebar();
    renderStats();
    renderParticipants();
  }

  function renderMarkers() {
    for (const m of markers.values()) map.removeLayer(m);
    markers.clear();
    for (const p of state.pins) {
      const marker = L.marker([p.lat, p.lng], { icon: pinIcon(p) }).addTo(map);
      marker.bindPopup(popupHtml(p));
      marker.on('popupopen', () => bindPopupActions());
      marker.on('click', () => setActiveListItem(p.id));
      markers.set(p.id, marker);
    }
  }

  function popupHtml(p) {
    const stars = '★'.repeat(p.rating || 0) + '☆'.repeat(5 - (p.rating || 0));
    return `
      <div class="popup">
        <div class="popup-title">${escapeHtml(p.name)}</div>
        ${p.country ? `<div class="popup-country">${escapeHtml(p.country)}</div>` : ''}
        ${p.date ? `<div class="popup-country">${formatDate(p.date)}</div>` : ''}
        <div class="place-stars">${stars}</div>
        <div class="popup-author"><span class="author-dot" style="background:${p.authorColor}"></span>Pinned by ${escapeHtml(p.authorName)}</div>
        ${p.notes ? `<div class="popup-notes">${escapeHtml(p.notes)}</div>` : ''}
        <div class="popup-actions">
          <button data-action="edit" data-id="${p.id}">Edit</button>
          <button data-action="delete" data-id="${p.id}">Delete</button>
        </div>
      </div>`;
  }

  function bindPopupActions() {
    const container = document.querySelector('.leaflet-popup');
    if (!container) return;
    container.querySelectorAll('[data-action="edit"]').forEach((btn) =>
      btn.addEventListener('click', () => openModal(btn.dataset.id))
    );
    container.querySelectorAll('[data-action="delete"]').forEach((btn) =>
      btn.addEventListener('click', () => deletePinRemote(btn.dataset.id))
    );
  }

  function renderSidebar() {
    const list = document.getElementById('placeList');
    const empty = document.getElementById('emptyState');
    const query = document.getElementById('searchInput').value.trim().toLowerCase();

    const filtered = state.pins
      .filter((p) => {
        if (!query) return true;
        return (
          p.name.toLowerCase().includes(query) ||
          (p.country || '').toLowerCase().includes(query) ||
          (p.notes || '').toLowerCase().includes(query) ||
          (p.authorName || '').toLowerCase().includes(query)
        );
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    list.innerHTML = '';
    empty.classList.toggle('visible', state.pins.length === 0);

    for (const p of filtered) {
      const li = document.createElement('li');
      li.className = 'place-item' + (p.id === activeId ? ' active' : '');
      li.dataset.id = p.id;
      const stars = '★'.repeat(p.rating || 0);
      li.innerHTML = `
        <div class="place-item-top">
          <span class="place-name">${escapeHtml(p.name)}</span>
        </div>
        <div class="place-country">${escapeHtml(p.country || '')}</div>
        <div class="place-meta">
          <span class="place-author"><span class="author-dot" style="background:${p.authorColor}"></span>${escapeHtml(p.authorName)}</span>
          <span class="place-stars">${stars}</span>
        </div>`;
      li.addEventListener('click', () => {
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 6), { animate: true });
        const marker = markers.get(p.id);
        if (marker) marker.openPopup();
        setActiveListItem(p.id);
      });
      list.appendChild(li);
    }
  }

  function setActiveListItem(id) {
    activeId = id;
    document.querySelectorAll('.place-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  }

  function renderStats() {
    document.getElementById('statPlaces').textContent = state.pins.length;
    const countries = new Set(
      state.pins.map((p) => (p.country || '').trim().toLowerCase()).filter(Boolean)
    );
    document.getElementById('statCountries').textContent = countries.size;
  }

  function renderParticipants() {
    const el = document.getElementById('participants');
    const seen = new Map();
    if (state.identity) seen.set(state.identity.name, state.identity.color);
    for (const p of state.pins) seen.set(p.authorName, p.authorColor);

    el.innerHTML = '';
    for (const [name, color] of seen) {
      const av = document.createElement('div');
      av.className = 'avatar';
      av.style.background = color;
      av.title = name;
      av.textContent = name.trim().charAt(0).toUpperCase();
      el.appendChild(av);
    }

    const badge = document.getElementById('identityBadge');
    if (state.identity) {
      badge.innerHTML = `<span class="author-dot" style="background:${state.identity.color}"></span>Pinning as <strong>${escapeHtml(state.identity.name)}</strong>`;
    }
  }

  // ---------- pin modal ----------
  const backdrop = document.getElementById('modalBackdrop');
  const form = document.getElementById('pinForm');
  const ratingInput = document.getElementById('ratingInput');

  function openModal(id) {
    activeId = id;
    const editing = !!id;
    document.getElementById('modalTitle').textContent = editing ? 'Edit pin' : 'New pin';
    document.getElementById('deletePinBtn').hidden = !editing;

    const place = editing ? state.pins.find((p) => p.id === id) : null;

    document.getElementById('pinName').value = place ? place.name : '';
    document.getElementById('pinCountry').value = place ? place.country || '' : '';
    document.getElementById('pinDate').value = place ? place.date || '' : '';
    document.getElementById('pinNotes').value = place ? place.notes || '' : '';
    setRating(place ? place.rating || 0 : 0);

    backdrop.classList.add('visible');
    setTimeout(() => document.getElementById('pinName').focus(), 50);
  }

  function closeModal() {
    backdrop.classList.remove('visible');
    pendingLatLng = null;
    activeId = null;
    form.reset();
    setRating(0);
  }

  function setRating(value) {
    ratingInput.dataset.value = String(value);
    ratingInput.querySelectorAll('span').forEach((s) => {
      s.classList.toggle('filled', Number(s.dataset.star) <= value);
    });
  }

  ratingInput.addEventListener('click', (e) => {
    const star = e.target.closest('span[data-star]');
    if (!star) return;
    setRating(Number(star.dataset.star));
  });

  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('visible')) closeModal();
  });

  document.getElementById('deletePinBtn').addEventListener('click', () => {
    if (activeId) deletePinRemote(activeId);
    closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editingPlace = activeId ? state.pins.find((p) => p.id === activeId) : null;
    const latLng = editingPlace ? { lat: editingPlace.lat, lng: editingPlace.lng } : pendingLatLng;
    if (!latLng) return;

    const name = document.getElementById('pinName').value.trim();
    if (!name) return;

    const data = {
      lat: latLng.lat,
      lng: latLng.lng,
      name,
      country: document.getElementById('pinCountry').value.trim(),
      date: document.getElementById('pinDate').value,
      notes: document.getElementById('pinNotes').value.trim(),
      rating: Number(ratingInput.dataset.value) || 0,
      authorName: editingPlace ? editingPlace.authorName : state.identity.name,
      authorColor: editingPlace ? editingPlace.authorColor : state.identity.color,
    };

    if (editingPlace) await updatePinRemote(editingPlace.id, data);
    else await createPinRemote(data);

    closeModal();
  });

  // ---------- search ----------
  document.getElementById('searchInput').addEventListener('input', renderSidebar);

  // ---------- theme ----------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  document.getElementById('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  // ---------- export ----------
  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.pins, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pinpoint-${state.code}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---------- toasts ----------
  function showToast(text) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---------- helpers ----------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ---------- init ----------
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');

  const pathMatch = location.pathname.match(/^\/m\/([A-Za-z0-9]{4,8})$/);
  if (pathMatch) {
    const code = pathMatch[1].toUpperCase();
    const identity = loadIdentity(code);
    if (identity) {
      enterMap(code, identity);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelector('.tab[data-tab="join"]').click();
        document.getElementById('joinCode').value = code;
      });
    }
  }
})();
