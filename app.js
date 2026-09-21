(() => {
  'use strict';

  const STORAGE_KEY = 'pinpoint.places.v1';
  const THEME_KEY = 'pinpoint.theme';

  /** @type {{id:string, lat:number, lng:number, name:string, country:string, date:string, notes:string, rating:number}[]} */
  let places = loadPlaces();
  let markers = new Map(); // id -> L.Marker
  let activeId = null; // place currently open in the modal (for edit)
  let pendingLatLng = null; // for new pin creation

  // ---------- persistence ----------
  function loadPlaces() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function savePlaces() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // ---------- map ----------
  const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2.4);

  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  function pinIcon() {
    return L.divIcon({
      className: 'pinpoint-marker',
      html: '<div style="font-size:26px;line-height:26px;transform:translate(-50%,-90%);filter:drop-shadow(0 2px 2px rgba(0,0,0,.35))">📍</div>',
      iconSize: [0, 0],
    });
  }

  map.on('click', (e) => {
    pendingLatLng = e.latlng;
    openModal(null);
  });

  // ---------- rendering ----------
  function renderAll() {
    renderMarkers();
    renderSidebar();
    renderStats();
  }

  function renderMarkers() {
    for (const m of markers.values()) map.removeLayer(m);
    markers.clear();
    for (const p of places) {
      const marker = L.marker([p.lat, p.lng], { icon: pinIcon() }).addTo(map);
      marker.bindPopup(popupHtml(p));
      marker.on('popupopen', () => bindPopupActions(p.id));
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
        ${p.notes ? `<div class="popup-notes">${escapeHtml(p.notes)}</div>` : ''}
        <div class="popup-actions">
          <button data-action="edit" data-id="${p.id}">Edit</button>
          <button data-action="delete" data-id="${p.id}">Delete</button>
        </div>
      </div>`;
  }

  function bindPopupActions(id) {
    const container = document.querySelector('.leaflet-popup');
    if (!container) return;
    container.querySelectorAll('[data-action="edit"]').forEach((btn) =>
      btn.addEventListener('click', () => openModal(id))
    );
    container.querySelectorAll('[data-action="delete"]').forEach((btn) =>
      btn.addEventListener('click', () => deletePlace(id))
    );
  }

  function renderSidebar() {
    const list = document.getElementById('placeList');
    const empty = document.getElementById('emptyState');
    const query = document.getElementById('searchInput').value.trim().toLowerCase();

    const filtered = places
      .filter((p) => {
        if (!query) return true;
        return (
          p.name.toLowerCase().includes(query) ||
          (p.country || '').toLowerCase().includes(query) ||
          (p.notes || '').toLowerCase().includes(query)
        );
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    list.innerHTML = '';
    empty.classList.toggle('visible', places.length === 0);

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
          <span>${p.date ? formatDate(p.date) : ''}</span>
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
    document.getElementById('statPlaces').textContent = places.length;
    const countries = new Set(
      places.map((p) => (p.country || '').trim().toLowerCase()).filter(Boolean)
    );
    document.getElementById('statCountries').textContent = countries.size;
  }

  // ---------- CRUD ----------
  function deletePlace(id) {
    places = places.filter((p) => p.id !== id);
    savePlaces();
    renderAll();
    closeModal();
  }

  function upsertPlace(data) {
    const idx = places.findIndex((p) => p.id === data.id);
    if (idx >= 0) places[idx] = data;
    else places.push(data);
    savePlaces();
    renderAll();
  }

  // ---------- modal ----------
  const backdrop = document.getElementById('modalBackdrop');
  const form = document.getElementById('pinForm');
  const ratingInput = document.getElementById('ratingInput');

  function openModal(id) {
    activeId = id;
    const editing = !!id;
    document.getElementById('modalTitle').textContent = editing ? 'Edit pin' : 'New pin';
    document.getElementById('deletePinBtn').hidden = !editing;

    const place = editing ? places.find((p) => p.id === id) : null;

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
    if (activeId) deletePlace(activeId);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const editingPlace = activeId ? places.find((p) => p.id === activeId) : null;
    const latLng = editingPlace
      ? { lat: editingPlace.lat, lng: editingPlace.lng }
      : pendingLatLng;
    if (!latLng) return;

    const data = {
      id: editingPlace ? editingPlace.id : uid(),
      lat: latLng.lat,
      lng: latLng.lng,
      name: document.getElementById('pinName').value.trim(),
      country: document.getElementById('pinCountry').value.trim(),
      date: document.getElementById('pinDate').value,
      notes: document.getElementById('pinNotes').value.trim(),
      rating: Number(ratingInput.dataset.value) || 0,
    };
    if (!data.name) return;

    upsertPlace(data);
    activeId = data.id;
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

  // ---------- export / import ----------
  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(places, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pinpoint-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });

  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error('Invalid file format');
      const existingIds = new Set(places.map((p) => p.id));
      for (const p of imported) {
        if (
          typeof p.lat === 'number' &&
          typeof p.lng === 'number' &&
          typeof p.name === 'string'
        ) {
          const id = existingIds.has(p.id) ? uid() : p.id || uid();
          places.push({
            id,
            lat: p.lat,
            lng: p.lng,
            name: p.name,
            country: p.country || '',
            date: p.date || '',
            notes: p.notes || '',
            rating: Number(p.rating) || 0,
          });
        }
      }
      savePlaces();
      renderAll();
    } catch (err) {
      alert('Could not import file: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

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
  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(savedTheme);
  renderAll();
})();
