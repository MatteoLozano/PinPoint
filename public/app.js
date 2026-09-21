(() => {
  'use strict';

  const THEME_KEY = 'pinpoint.theme';
  const PALETTE = ['#3468e0', '#16a34a', '#f5a623', '#8b5cf6', '#06b6d4', '#e0483f', '#64748b', '#ec6fa0'];
  const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
  const clientId = crypto.randomUUID();

  const TAG_DEFS = [
    { id: 'food', label: 'Food', emoji: '🍜' },
    { id: 'viewpoint', label: 'Viewpoint', emoji: '🏔️' },
    { id: 'hotel', label: 'Hotel', emoji: '🛏️' },
    { id: 'activity', label: 'Activity', emoji: '🎟️' },
    { id: 'nature', label: 'Nature', emoji: '🌿' },
    { id: 'shopping', label: 'Shopping', emoji: '🛍️' },
    { id: 'transport', label: 'Transport', emoji: '🚗' },
    { id: 'other', label: 'Other', emoji: '📍' },
  ];
  const TAG_BY_ID = new Map(TAG_DEFS.map((t) => [t.id, t]));

  const state = {
    code: null,
    mapName: '',
    pins: [],
    comments: new Map(), // pinId -> [{id, pinId, authorName, authorColor, text, createdAt}]
    reactions: new Map(), // pinId -> [{id, pinId, authorName, authorColor, emoji, createdAt}]
    participants: [], // live presence from the server: [{clientId, name, color, isViewer}]
    identity: null, // { name, color }
    readOnly: false,
    ws: null,
  };

  function groupByPinId(items) {
    const grouped = new Map();
    for (const item of items || []) {
      if (!grouped.has(item.pinId)) grouped.set(item.pinId, []);
      grouped.get(item.pinId).push(item);
    }
    return grouped;
  }

  // sidebar / map filters (client-only, not persisted server-side)
  const filterState = {
    visit: 'all', // 'all' | 'visited' | 'wishlist'
    tags: new Set(), // empty set = no tag filtering
  };

  let map = null;
  let markerCluster = null; // L.markerClusterGroup
  let markers = new Map(); // id -> L.Marker
  let activeId = null; // pin id currently open in modal (edit) or null (new)
  let pendingLatLng = null;

  let modalTags = new Set(); // tag ids selected in the modal
  let modalWishlist = false;

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
  function withLoading(btn, fn) {
    return async (e) => {
      e.preventDefault();
      btn.classList.add('btn-loading');
      btn.disabled = true;
      try {
        await fn();
      } finally {
        btn.classList.remove('btn-loading');
        btn.disabled = false;
      }
    };
  }

  document.getElementById('createForm').addEventListener(
    'submit',
    withLoading(document.querySelector('#createForm button[type="submit"]'), async () => {
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
    })
  );

  document.getElementById('joinForm').addEventListener(
    'submit',
    withLoading(document.querySelector('#joinForm button[type="submit"]'), async () => {
      hideLandingError();
      const code = document.getElementById('joinCode').value.trim().toUpperCase();
      const yourName = document.getElementById('joinYourName').value.trim();
      if (!code || !yourName) return;
      const identity = { name: yourName, color: getJoinColor() };
      saveIdentity(code, identity);
      await enterMap(code, identity);
    })
  );

  // ---------- entering / leaving a map ----------
  async function enterMap(code, identity, opts = {}) {
    code = code.toUpperCase();
    const readOnly = !!opts.readOnly;
    try {
      const res = await fetch(`/api/maps/${code}`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();

      state.code = data.code;
      state.mapName = data.name;
      state.pins = data.pins;
      state.comments = groupByPinId(data.comments);
      state.reactions = groupByPinId(data.reactions);
      state.participants = [];
      state.identity = identity;
      state.readOnly = readOnly;

      history.pushState({}, '', `/m/${data.code}${readOnly ? '?view=1' : ''}`);
      showMapApp();
      connectSocket(data.code);
    } catch {
      if (readOnly) {
        showLandingError("Couldn't find that map — double-check the link.");
        return;
      }
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
    state.comments = new Map();
    state.reactions = new Map();
    state.participants = [];
    state.readOnly = false;
    for (const m of markers.values()) markerCluster ? markerCluster.removeLayer(m) : map.removeLayer(m);
    markers.clear();
    filterState.visit = 'all';
    filterState.tags.clear();
    document.querySelectorAll('#visitFilter .seg').forEach((s) => s.classList.toggle('active', s.dataset.filter === 'all'));
    history.pushState({}, '', '/');
    document.getElementById('mapApp').hidden = true;
    document.getElementById('landing').hidden = false;
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('open');
  }

  function showMapApp() {
    document.getElementById('landing').hidden = true;
    document.getElementById('mapApp').hidden = false;
    document.getElementById('mapTitle').textContent = state.mapName || 'PinPoint';
    document.getElementById('mapCodeText').textContent = state.code;
    document.title = `${state.mapName} · PinPoint`;

    document.querySelector('.sidebar-hint').textContent = state.readOnly
      ? 'You have a read-only view of this map.'
      : 'Click anywhere on the map to drop a pin, or search for one above the map.';
    document.getElementById('shareViewBtn').hidden = state.readOnly;
    document.body.classList.toggle('read-only', state.readOnly);

    if (!map) initMap();
    else map.invalidateSize();

    renderAll();
    setTimeout(() => map && map.invalidateSize(), 50);
  }

  document.getElementById('leaveBtn').addEventListener('click', leaveMap);

  // ---------- mobile sidebar drawer ----------
  const sidebarEl = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');

  function openSidebar() {
    sidebarEl.classList.add('open');
    sidebarBackdrop.classList.add('open');
  }
  function closeSidebar() {
    sidebarEl.classList.remove('open');
    sidebarBackdrop.classList.remove('open');
  }
  document.getElementById('sidebarToggle').addEventListener('click', openSidebar);
  document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
  sidebarBackdrop.addEventListener('click', closeSidebar);

  document.getElementById('mapCodeChip').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.code);
      showToast('Code copied!');
    } catch {
      showToast(`Share this code: ${state.code}`);
    }
  });

  document.getElementById('shareViewBtn').addEventListener('click', async () => {
    const url = `${location.origin}/m/${state.code}?view=1`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Read-only link copied!');
    } catch {
      showToast(`Share this view-only link: ${url}`);
    }
  });

  // ---------- map ----------
  function initMap() {
    map = L.map('map', { zoomControl: true, worldCopyJump: true, fadeAnimation: true }).setView([20, 0], 2.4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    markerCluster = L.markerClusterGroup({
      maxClusterRadius: 46,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(markerCluster);

    map.on('click', (e) => {
      if (state.readOnly) return;
      pendingLatLng = e.latlng;
      openModal(null);
    });
  }

  function clusterIcon(cluster) {
    const count = cluster.getChildCount();
    const size = count < 10 ? 34 : count < 50 ? 40 : 46;
    return L.divIcon({
      html: `<div class="cluster-body">${count}</div>`,
      className: 'pin-cluster',
      iconSize: [size, size],
    });
  }

  function pinIcon(pin) {
    const wishlist = !!(pin && pin.wishlist);
    return L.divIcon({
      className: 'pin-marker-wrapper',
      html: wishlist
        ? `<div class="pin-marker pin-marker--wishlist">
             <div class="pin-body-wish">★</div>
           </div>`
        : `<div class="pin-marker">
             <div class="pin-body"></div>
           </div>`,
      iconSize: wishlist ? [24, 24] : [20, 26],
      iconAnchor: wishlist ? [12, 12] : [10, 26],
      popupAnchor: wishlist ? [0, -12] : [0, -24],
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
      ws.send(JSON.stringify({
        type: 'join',
        code,
        clientId,
        name: state.identity ? state.identity.name : 'Viewer',
        color: state.identity ? state.identity.color : '#94a3b8',
        viewOnly: state.readOnly,
      }));
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
        showToast(`${msg.pin.authorName} pinned ${msg.pin.name}`);
      } else if (msg.type === 'pin:updated') {
        upsertPinLocal(msg.pin);
      } else if (msg.type === 'pin:deleted') {
        removePinLocal(msg.id);
      } else if (msg.type === 'presence') {
        state.participants = msg.participants;
        renderParticipants();
      } else if (msg.type === 'comment:created') {
        addCommentLocal(msg.pinId, msg.comment);
        const pin = state.pins.find((p) => p.id === msg.pinId);
        if (pin) showToast(`${msg.comment.authorName} commented on ${pin.name}`);
      } else if (msg.type === 'comment:deleted') {
        removeCommentLocal(msg.pinId, msg.commentId);
      } else if (msg.type === 'reaction:updated') {
        state.reactions.set(msg.pinId, msg.reactions);
        refreshPinPopup(msg.pinId);
        renderSidebar();
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

  const UNDO_WINDOW_MS = 5000;
  const pendingDeletions = new Map(); // id -> { pin, code, timer }

  // Removes the pin locally right away and gives the person a few seconds to
  // undo before the deletion is actually sent to the server (and to everyone
  // else on the map) — so an undo never causes a delete/recreate flicker for
  // anyone else watching the map.
  function requestDeletePin(id) {
    if (pendingDeletions.has(id)) return;
    const pin = state.pins.find((p) => p.id === id);
    if (!pin) return;
    const code = state.code;

    removePinLocal(id);

    const timer = setTimeout(() => finalizeDeletePin(id), UNDO_WINDOW_MS);
    pendingDeletions.set(id, { pin, code, timer });

    showUndoToast(`Deleted "${pin.name}"`, UNDO_WINDOW_MS, () => undoDeletePin(id));
  }

  function undoDeletePin(id) {
    const pending = pendingDeletions.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDeletions.delete(id);
    if (state.code === pending.code) upsertPinLocal(pending.pin);
  }

  async function finalizeDeletePin(id) {
    const pending = pendingDeletions.get(id);
    if (!pending) return;
    pendingDeletions.delete(id);
    await fetch(`/api/maps/${pending.code}/pins/${id}?clientId=${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
    });
  }

  // ---------- comments & reactions ----------
  function refreshPinPopup(pinId) {
    const marker = markers.get(pinId);
    const pin = state.pins.find((p) => p.id === pinId);
    if (!marker || !pin) return;
    marker.setPopupContent(popupHtml(pin));
    if (marker.isPopupOpen()) bindPopupActions(pinId);
  }

  function addCommentLocal(pinId, comment) {
    if (!state.comments.has(pinId)) state.comments.set(pinId, []);
    const list = state.comments.get(pinId);
    if (!list.some((c) => c.id === comment.id)) list.push(comment);
    refreshPinPopup(pinId);
    renderSidebar();
  }

  function removeCommentLocal(pinId, commentId) {
    const list = state.comments.get(pinId);
    if (!list) return;
    state.comments.set(pinId, list.filter((c) => c.id !== commentId));
    refreshPinPopup(pinId);
    renderSidebar();
  }

  async function addCommentRemote(pinId, text) {
    const res = await fetch(`/api/maps/${state.code}/pins/${pinId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, authorName: state.identity.name, authorColor: state.identity.color, clientId }),
    });
    if (!res.ok) return;
    addCommentLocal(pinId, await res.json());
  }

  async function deleteCommentRemote(pinId, commentId) {
    removeCommentLocal(pinId, commentId);
    await fetch(`/api/maps/${state.code}/pins/${pinId}/comments/${commentId}?clientId=${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
    });
  }

  async function toggleReactionRemote(pinId, emoji) {
    const res = await fetch(`/api/maps/${state.code}/pins/${pinId}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji, authorName: state.identity.name, authorColor: state.identity.color, clientId }),
    });
    if (!res.ok) return;
    const { reactions } = await res.json();
    state.reactions.set(pinId, reactions);
    refreshPinPopup(pinId);
    renderSidebar();
  }

  // ---------- rendering ----------
  function renderAll() {
    renderMarkers();
    renderSidebar();
    renderStats();
    renderParticipants();
  }

  function pinsEqual(a, b) {
    return (
      a.lat === b.lat &&
      a.lng === b.lng &&
      a.name === b.name &&
      a.date === b.date &&
      a.notes === b.notes &&
      a.rating === b.rating &&
      a.authorName === b.authorName &&
      a.authorColor === b.authorColor &&
      !!a.wishlist === !!b.wishlist &&
      JSON.stringify(a.tags || []) === JSON.stringify(b.tags || [])
    );
  }

  function pinMatchesFilters(p) {
    if (filterState.visit === 'visited' && p.wishlist) return false;
    if (filterState.visit === 'wishlist' && !p.wishlist) return false;
    if (filterState.tags.size > 0) {
      const tags = p.tags || [];
      if (!tags.some((t) => filterState.tags.has(t))) return false;
    }
    return true;
  }

  function renderMarkers() {
    const currentIds = new Set(state.pins.map((p) => p.id));

    // remove markers for pins that are gone, with a shrink-out animation
    for (const [id, marker] of markers) {
      if (currentIds.has(id)) continue;
      markers.delete(id);
      const el = marker.getElement();
      if (el) {
        el.classList.add('pin-removing');
        setTimeout(() => markerCluster.removeLayer(marker), 200);
      } else {
        markerCluster.removeLayer(marker);
      }
    }

    // add new pins / update ones that changed, leave unchanged markers alone
    for (const p of state.pins) {
      const existing = markers.get(p.id);
      if (existing) {
        if (!pinsEqual(existing._pin, p)) {
          existing.setLatLng([p.lat, p.lng]);
          existing.setIcon(pinIcon(p));
          existing.setPopupContent(popupHtml(p));
          existing._pin = p;
        }
      } else {
        const marker = L.marker([p.lat, p.lng], { icon: pinIcon(p) });
        marker.bindPopup(popupHtml(p), { minWidth: 230, maxWidth: 280 });
        marker.on('popupopen', () => bindPopupActions(p.id));
        marker.on('click', () => setActiveListItem(p.id));
        marker._pin = p;
        markers.set(p.id, marker);
      }

      const marker = markers.get(p.id);
      const shouldShow = pinMatchesFilters(p);
      const isShown = markerCluster.hasLayer(marker);
      if (shouldShow && !isShown) markerCluster.addLayer(marker);
      else if (!shouldShow && isShown) markerCluster.removeLayer(marker);
    }

    renderTagFilters();
  }

  function popupHtml(p) {
    const stars = '★'.repeat(p.rating || 0) + '☆'.repeat(5 - (p.rating || 0));
    const tags = p.tags || [];
    const wishlistBadge = p.wishlist ? `<div class="popup-wishlist">🌟 Want to visit</div>` : '';
    const tagsHtml = tags.length
      ? `<div class="popup-tags">${tags
          .map((t) => {
            const def = TAG_BY_ID.get(t);
            return `<span class="tag-chip">${def ? def.emoji + ' ' + escapeHtml(def.label) : escapeHtml(t)}</span>`;
          })
          .join('')}</div>`
      : '';
    const myName = state.identity ? state.identity.name : null;
    const reactions = state.reactions.get(p.id) || [];
    const reactionCounts = {};
    for (const r of reactions) {
      if (!reactionCounts[r.emoji]) reactionCounts[r.emoji] = { count: 0, mine: false };
      reactionCounts[r.emoji].count++;
      if (r.authorName === myName) reactionCounts[r.emoji].mine = true;
    }
    const reactionsHtml = `<div class="popup-reactions">${REACTION_EMOJIS.map((emoji) => {
      const info = reactionCounts[emoji];
      if (!info && state.readOnly) return '';
      return `<button type="button" class="reaction-btn${info && info.mine ? ' active' : ''}" data-action="react" data-id="${p.id}" data-emoji="${emoji}"${state.readOnly ? ' disabled' : ''}>${emoji}${info ? `<span class="reaction-count">${info.count}</span>` : ''}</button>`;
    }).join('')}</div>`;

    const comments = state.comments.get(p.id) || [];
    const commentsHtml = comments.length
      ? comments
          .map(
            (c) => `<div class="comment">
              <span class="author-dot" style="background:${c.authorColor}"></span>
              <div class="comment-body"><span class="comment-author">${escapeHtml(c.authorName)}</span> <span class="comment-text">${escapeHtml(c.text)}</span></div>
              ${!state.readOnly && c.authorName === myName ? `<button type="button" class="comment-delete" data-action="delete-comment" data-id="${p.id}" data-comment-id="${c.id}" title="Delete comment">✕</button>` : ''}
            </div>`
          )
          .join('')
      : `<div class="comment-empty">No comments yet.</div>`;
    const commentFormHtml = state.readOnly
      ? ''
      : `<form class="popup-comment-form" data-id="${p.id}">
           <input type="text" class="comment-input" placeholder="Add a comment…" maxlength="300" autocomplete="off" />
           <button type="submit" class="comment-send" title="Send">➤</button>
         </form>`;

    return `
      <div class="popup">
        <div class="popup-title">${escapeHtml(p.name)}</div>
        ${p.date ? `<div class="popup-country">${formatDate(p.date)}</div>` : ''}
        ${wishlistBadge}
        <div class="place-stars">${stars}</div>
        ${tagsHtml}
        <div class="popup-author"><span class="author-dot" style="background:${p.authorColor}"></span>Pinned by ${escapeHtml(p.authorName)}</div>
        ${p.notes ? `<div class="popup-notes">${escapeHtml(p.notes)}</div>` : ''}
        ${state.readOnly ? '' : `<div class="popup-actions">
          <button data-action="edit" data-id="${p.id}">Edit</button>
          <button data-action="delete" data-id="${p.id}">Delete</button>
        </div>`}
        ${reactionsHtml}
        <div class="popup-comments">${commentsHtml}</div>
        ${commentFormHtml}
      </div>`;
  }

  function bindPopupActions(pinId) {
    const container = document.querySelector('.leaflet-popup');
    if (!container) return;
    container.querySelectorAll('[data-action="edit"]').forEach((btn) =>
      btn.addEventListener('click', () => openModal(btn.dataset.id))
    );
    container.querySelectorAll('[data-action="delete"]').forEach((btn) =>
      btn.addEventListener('click', () => requestDeletePin(btn.dataset.id))
    );
    container.querySelectorAll('[data-action="react"]').forEach((btn) =>
      btn.addEventListener('click', () => toggleReactionRemote(btn.dataset.id, btn.dataset.emoji))
    );
    container.querySelectorAll('[data-action="delete-comment"]').forEach((btn) =>
      btn.addEventListener('click', () => deleteCommentRemote(btn.dataset.id, btn.dataset.commentId))
    );
    const commentForm = container.querySelector('.popup-comment-form');
    if (commentForm) {
      commentForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = commentForm.querySelector('.comment-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        addCommentRemote(commentForm.dataset.id, text);
      });
    }
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
          (p.notes || '').toLowerCase().includes(query) ||
          (p.authorName || '').toLowerCase().includes(query)
        );
      })
      .filter(pinMatchesFilters)
      .sort((a, b) => b.createdAt - a.createdAt);

    list.innerHTML = '';
    empty.classList.toggle('visible', state.pins.length === 0);

    const noMatches = state.pins.length > 0 && filtered.length === 0;
    let noMatchesEl = document.getElementById('noMatchesState');
    if (noMatches) {
      if (!noMatchesEl) {
        noMatchesEl = document.createElement('div');
        noMatchesEl.id = 'noMatchesState';
        noMatchesEl.className = 'empty-state visible';
        noMatchesEl.innerHTML = `<div class="empty-icon">🔍</div><p>No places match your filters.</p>`;
        list.after(noMatchesEl);
      }
    } else if (noMatchesEl) {
      noMatchesEl.remove();
    }

    for (const p of filtered) {
      const li = document.createElement('li');
      li.className = 'place-item' + (p.id === activeId ? ' active' : '') + (p.wishlist ? ' wishlist' : '');
      li.dataset.id = p.id;
      const stars = '★'.repeat(p.rating || 0);
      const tagsHtml = (p.tags || [])
        .map((t) => {
          const def = TAG_BY_ID.get(t);
          return `<span class="tag-chip tag-chip-sm">${def ? def.emoji : '🏷️'}</span>`;
        })
        .join('');
      li.innerHTML = `
        <div class="place-item-top">
          <span class="place-name">${p.wishlist ? '🌟 ' : ''}${escapeHtml(p.name)}</span>
        </div>
        <div class="place-meta">
          <span class="place-author"><span class="author-dot" style="background:${p.authorColor}"></span>${escapeHtml(p.authorName)}</span>
          <span class="place-stars">${stars}</span>
        </div>
        ${tagsHtml ? `<div class="place-tags">${tagsHtml}</div>` : ''}`;
      li.addEventListener('click', () => {
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 6), { animate: true });
        const marker = markers.get(p.id);
        if (marker) {
          if (markerCluster.hasLayer(marker)) markerCluster.zoomToShowLayer(marker, () => marker.openPopup());
          else marker.openPopup();
        }
        setActiveListItem(p.id);
        if (window.innerWidth <= 820) closeSidebar();
      });
      list.appendChild(li);
    }
  }

  // ---------- tag / visit filters ----------
  function renderTagFilters() {
    const container = document.getElementById('tagFilters');
    const usedTags = new Set();
    for (const p of state.pins) for (const t of p.tags || []) usedTags.add(t);

    const defs = TAG_DEFS.filter((t) => usedTags.has(t.id));
    container.innerHTML = defs
      .map(
        (t) =>
          `<button type="button" class="tag-chip tag-filter-chip${filterState.tags.has(t.id) ? ' active' : ''}" data-tag="${t.id}">${t.emoji} ${escapeHtml(t.label)}</button>`
      )
      .join('');
    container.querySelectorAll('.tag-filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        if (filterState.tags.has(tag)) filterState.tags.delete(tag);
        else filterState.tags.add(tag);
        renderAll();
      });
    });
  }

  document.getElementById('visitFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    filterState.visit = btn.dataset.filter;
    document.querySelectorAll('#visitFilter .seg').forEach((s) => s.classList.toggle('active', s === btn));
    renderAll();
  });

  function setActiveListItem(id) {
    activeId = id;
    document.querySelectorAll('.place-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  }

  function renderStats() {
    document.getElementById('statPlaces').textContent = state.pins.length;
  }

  // ---------- extended stats & timeline ----------
  const statsBackdrop = document.getElementById('statsBackdrop');

  function computeExtendedStats() {
    const visited = state.pins.filter((p) => !p.wishlist);
    const wishlist = state.pins.filter((p) => p.wishlist);
    return { visitedCount: visited.length, wishlistCount: wishlist.length };
  }

  function renderStatsPanel() {
    const stats = computeExtendedStats();
    const grid = document.getElementById('statsGrid');
    grid.innerHTML = `
      <div class="stat-tile"><span class="stat-tile-num">${stats.visitedCount}</span><span class="stat-tile-label">places visited</span></div>
      <div class="stat-tile"><span class="stat-tile-num">${stats.wishlistCount}</span><span class="stat-tile-label">on wishlist</span></div>
    `;

    const timeline = document.getElementById('timelineList');
    const dated = state.pins
      .filter((p) => !p.wishlist && p.date)
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!dated.length) {
      timeline.innerHTML = `<div class="timeline-empty">Add a visit date to your pins to see them here.</div>`;
      return;
    }

    timeline.innerHTML = dated
      .map(
        (p) => `
        <div class="timeline-item">
          <div class="timeline-dot" style="background:${p.authorColor}"></div>
          <div class="timeline-content">
            <div class="timeline-date">${formatDate(p.date)}</div>
            <div class="timeline-name">${escapeHtml(p.name)}</div>
          </div>
        </div>`
      )
      .join('');
  }

  function openStatsPanel() {
    renderStatsPanel();
    statsBackdrop.classList.add('visible');
  }
  function closeStatsPanel() {
    statsBackdrop.classList.remove('visible');
  }
  document.getElementById('statsBtn').addEventListener('click', openStatsPanel);
  document.getElementById('closeStatsBtn').addEventListener('click', closeStatsPanel);
  statsBackdrop.addEventListener('click', (e) => {
    if (e.target === statsBackdrop) closeStatsPanel();
  });

  function renderParticipants() {
    const el = document.getElementById('participants');

    // start from everyone who has ever pinned (shown offline by default),
    // then overlay live presence from the server for who's online right now
    const people = new Map(); // name -> { color, online }
    for (const p of state.pins) {
      if (!people.has(p.authorName)) people.set(p.authorName, { color: p.authorColor, online: false });
    }
    if (state.identity && !people.has(state.identity.name)) {
      people.set(state.identity.name, { color: state.identity.color, online: false });
    }

    let viewerCount = 0;
    for (const participant of state.participants) {
      if (participant.isViewer) {
        viewerCount++;
        continue;
      }
      const existing = people.get(participant.name);
      people.set(participant.name, { color: participant.color || (existing && existing.color) || '#64748b', online: true });
    }

    el.innerHTML = '';
    for (const [name, info] of people) {
      const av = document.createElement('div');
      av.className = 'avatar' + (info.online ? ' online' : ' offline');
      av.style.background = info.color;
      av.title = info.online ? `${name} · online` : name;
      av.textContent = name.trim().charAt(0).toUpperCase();
      el.appendChild(av);
    }
    if (viewerCount > 0) {
      const badge = document.createElement('div');
      badge.className = 'avatar avatar-viewers';
      badge.title = `${viewerCount} viewing (read-only)`;
      badge.textContent = `👁${viewerCount}`;
      el.appendChild(badge);
    }

    const identityBadge = document.getElementById('identityBadge');
    if (state.readOnly) {
      identityBadge.innerHTML = `👁 Viewing (read-only)`;
    } else if (state.identity) {
      identityBadge.innerHTML = `<span class="author-dot" style="background:${state.identity.color}"></span>Pinning as <strong>${escapeHtml(state.identity.name)}</strong>`;
    }
  }

  // ---------- pin modal ----------
  const backdrop = document.getElementById('modalBackdrop');
  const form = document.getElementById('pinForm');
  const ratingInput = document.getElementById('ratingInput');

  let modalCloseTimer = null;

  function openModal(id) {
    if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; }
    backdrop.classList.remove('closing');
    activeId = id;
    const editing = !!id;
    document.getElementById('modalTitle').textContent = editing ? 'Edit pin' : 'New pin';
    document.getElementById('deletePinBtn').hidden = !editing;

    const place = editing ? state.pins.find((p) => p.id === id) : null;

    document.getElementById('pinName').value = place ? place.name : '';
    document.getElementById('pinDate').value = place ? place.date || '' : '';
    document.getElementById('pinNotes').value = place ? place.notes || '' : '';
    setRating(place ? place.rating || 0 : 0);

    modalWishlist = place ? !!place.wishlist : false;
    modalTags = new Set(place ? place.tags || [] : []);

    renderVisitToggle();
    renderTagPicker();

    backdrop.classList.add('visible');
    setTimeout(() => document.getElementById('pinName').focus(), 50);
  }

  function closeModal() {
    backdrop.classList.add('closing');
    modalCloseTimer = setTimeout(() => {
      backdrop.classList.remove('visible', 'closing');
      pendingLatLng = null;
      activeId = null;
      form.reset();
      setRating(0);
      modalWishlist = false;
      modalTags = new Set();
      modalCloseTimer = null;
    }, 180);
  }

  // ---------- modal: wishlist toggle ----------
  function renderVisitToggle() {
    document.querySelectorAll('#visitToggle .visit-opt').forEach((btn) => {
      btn.classList.toggle('active', (btn.dataset.wishlist === '1') === modalWishlist);
    });
  }
  document.getElementById('visitToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.visit-opt');
    if (!btn) return;
    modalWishlist = btn.dataset.wishlist === '1';
    renderVisitToggle();
  });

  // ---------- modal: tag picker ----------
  function renderTagPicker() {
    const container = document.getElementById('tagPicker');
    container.innerHTML = TAG_DEFS.map(
      (t) => `<button type="button" class="tag-chip tag-pick-chip${modalTags.has(t.id) ? ' active' : ''}" data-tag="${t.id}">${t.emoji} ${escapeHtml(t.label)}</button>`
    ).join('');
    container.querySelectorAll('.tag-pick-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        if (modalTags.has(tag)) modalTags.delete(tag);
        else modalTags.add(tag);
        btn.classList.toggle('active');
      });
    });
  }

  function setRating(value) {
    ratingInput.dataset.value = String(value);
    paintRating(value);
  }

  function paintRating(value) {
    ratingInput.querySelectorAll('span').forEach((s) => {
      s.classList.toggle('filled', Number(s.dataset.star) <= value);
    });
  }

  ratingInput.addEventListener('click', (e) => {
    const star = e.target.closest('span[data-star]');
    if (!star) return;
    setRating(Number(star.dataset.star));
  });
  ratingInput.addEventListener('mouseover', (e) => {
    const star = e.target.closest('span[data-star]');
    if (!star) return;
    paintRating(Number(star.dataset.star));
  });
  ratingInput.addEventListener('mouseleave', () => {
    paintRating(Number(ratingInput.dataset.value) || 0);
  });

  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (backdrop.classList.contains('visible')) closeModal();
    else if (statsBackdrop.classList.contains('visible')) closeStatsPanel();
  });

  document.getElementById('deletePinBtn').addEventListener('click', () => {
    if (activeId) requestDeletePin(activeId);
    closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.readOnly) return;
    const editingPlace = activeId ? state.pins.find((p) => p.id === activeId) : null;
    const latLng = editingPlace ? { lat: editingPlace.lat, lng: editingPlace.lng } : pendingLatLng;
    if (!latLng) return;

    const name = document.getElementById('pinName').value.trim();
    if (!name) return;

    const data = {
      lat: latLng.lat,
      lng: latLng.lng,
      name,
      date: document.getElementById('pinDate').value,
      notes: document.getElementById('pinNotes').value.trim(),
      rating: Number(ratingInput.dataset.value) || 0,
      authorName: editingPlace ? editingPlace.authorName : state.identity.name,
      authorColor: editingPlace ? editingPlace.authorColor : state.identity.color,
      wishlist: modalWishlist,
      tags: [...modalTags],
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

  // ---------- toasts ----------
  function showToast(text) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function showUndoToast(text, duration, onUndo) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast toast-undo';
    el.style.setProperty('--toast-duration', `${duration}ms`);

    const label = document.createElement('span');
    label.textContent = text;
    el.appendChild(label);

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'toast-action';
    undoBtn.textContent = 'Undo';
    el.appendChild(undoBtn);

    const bar = document.createElement('div');
    bar.className = 'toast-progress';
    el.appendChild(bar);

    container.appendChild(el);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.add('toast-leaving');
      setTimeout(() => el.remove(), 220);
    };

    const timer = setTimeout(dismiss, duration);
    undoBtn.addEventListener('click', () => {
      clearTimeout(timer);
      dismiss();
      onUndo();
    });
  }

  // ---------- place search / geocoding (Nominatim) ----------
  const geosearchInput = document.getElementById('geosearchInput');
  const geosearchResults = document.getElementById('geosearchResults');
  const geosearchClear = document.getElementById('geosearchClear');
  let geosearchDebounce = null;
  let geosearchLastRequestAt = 0;
  let geosearchAbort = null;

  async function runGeosearch(query) {
    // Respect Nominatim's usage policy of ~1 request/sec from a given client.
    const wait = Math.max(0, 1000 - (Date.now() - geosearchLastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geosearchLastRequestAt = Date.now();

    if (geosearchAbort) geosearchAbort.abort();
    geosearchAbort = new AbortController();

    try {
      // accept-language=en keeps result names consistent regardless of the
      // viewer's browser locale.
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&accept-language=en&limit=6&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { signal: geosearchAbort.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('geocode failed');
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') return null;
      return [];
    }
  }

  function renderGeosearchResults(results) {
    if (!results || !results.length) {
      geosearchResults.innerHTML = `<li class="geosearch-empty">No places found.</li>`;
      geosearchResults.hidden = false;
      return;
    }
    geosearchResults.innerHTML = results
      .map(
        (r, i) =>
          `<li class="geosearch-item" data-index="${i}">
             <span class="geosearch-item-name">${escapeHtml(r.display_name.split(',')[0])}</span>
             <span class="geosearch-item-sub">${escapeHtml(r.display_name)}</span>
           </li>`
      )
      .join('');
    geosearchResults.hidden = false;
    geosearchResults.querySelectorAll('.geosearch-item').forEach((li) => {
      li.addEventListener('click', () => pickGeosearchResult(results[Number(li.dataset.index)]));
    });
  }

  function pickGeosearchResult(result) {
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    geosearchResults.hidden = true;
    geosearchInput.value = result.display_name.split(',')[0];
    geosearchClear.hidden = false;

    const targetZoom = Math.max(map.getZoom(), 10);
    map.flyTo([lat, lng], targetZoom, { animate: true, duration: 1.1 });

    pendingLatLng = { lat, lng };

    const nameGuess = result.address
      ? result.address.city || result.address.town || result.address.village || result.address.state || result.display_name.split(',')[0]
      : result.display_name.split(',')[0];

    let opened = false;
    const openOnce = () => {
      if (opened) return;
      opened = true;
      openModal(null);
      document.getElementById('pinName').value = nameGuess;
    };
    map.once('moveend', openOnce);
    setTimeout(openOnce, 1500); // fallback in case moveend doesn't fire (e.g. flying to the current view)
  }

  geosearchInput.addEventListener('input', () => {
    const q = geosearchInput.value.trim();
    geosearchClear.hidden = !q;
    clearTimeout(geosearchDebounce);
    if (!q || q.length < 2) {
      geosearchResults.hidden = true;
      return;
    }
    geosearchDebounce = setTimeout(async () => {
      const results = await runGeosearch(q);
      if (results !== null) renderGeosearchResults(results);
    }, 450);
  });
  geosearchInput.addEventListener('focus', () => {
    if (geosearchResults.innerHTML && geosearchInput.value.trim().length >= 2) geosearchResults.hidden = false;
  });
  geosearchClear.addEventListener('click', () => {
    geosearchInput.value = '';
    geosearchClear.hidden = true;
    geosearchResults.hidden = true;
    geosearchInput.focus();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#geosearch')) geosearchResults.hidden = true;
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
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');

  const pathMatch = location.pathname.match(/^\/m\/([A-Za-z0-9]{4,8})$/);
  if (pathMatch) {
    const code = pathMatch[1].toUpperCase();
    const viewOnly = new URLSearchParams(location.search).get('view') === '1';
    if (viewOnly) {
      enterMap(code, null, { readOnly: true });
    } else {
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
  }
})();
