(() => {
  'use strict';

  // ---------- Helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => {
    if (!isFinite(s) || s <= 0) return '0:00';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };
  const uid = () => crypto.randomUUID();
  const fileUrl = (p) => {
    if (window.__fileUrl) return window.__fileUrl(p);
    let u = p.replace(/\\/g, '/');
    if (!u.startsWith('/')) u = '/' + u;
    return 'file://' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
  };
  const pathKey = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const setFill = (range) => range.style.setProperty('--p', (range.value / range.max) * 100 + '%');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const shuffled = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // Inline SVG icons: they follow the text color and look the same on every system.
  const svgIcon = (inner, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  const ICON = {
    play: svgIcon('<path d="M7 4.5v15l12-7.5z"/>'),
    pause: svgIcon('<rect x="6" y="5" width="4.5" height="14" rx="1"/><rect x="13.5" y="5" width="4.5" height="14" rx="1"/>'),
    close: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke'),
  };

  // Cover art. The red placeholder shows when there is no image (or it fails to load).
  const coverEl = (path, cls = 'sm') =>
    `<div class="cover ${cls}">${path ? `<img src="${esc(fileUrl(path))}" alt="" loading="lazy">` : ''}</div>`;
  document.addEventListener(
    'error',
    (e) => {
      if (e.target && e.target.tagName === 'IMG') e.target.remove();
    },
    true
  );

  // ---------- State ----------
  const DEFAULT_RPC_ID = '1571579692287262871';
  const DEFAULT_SORTS = { library: { key: 'added', dir: 1 }, albums: { key: 'name', dir: 1 }, album: { key: 'track', dir: 1 } };
  const SORT_LABELS = {
    title: 'Title', artist: 'Artist', album: 'Album', length: 'Length', added: 'Date added',
    track: 'Track number', custom: 'Custom order', name: 'Name', year: 'Year',
  };
  const defaultSettings = () => ({
    volume: 0.8, shuffle: false, repeat: 'off', gapless: true,
    rpcEnabled: false, rpcClientId: DEFAULT_RPC_ID, sorts: {},
    karaoke: { remover: false, strength: 100, tempo: 1, showAll: false, controls: null },
    mic: { deviceId: '', level: 100, monitor: false, monitorLevel: 70, recMode: 'mix', syncMs: null },
    onlineLyrics: false, recordFolder: '', recAddToLibrary: true,
  });

  // Two audio elements: one plays while the other preloads the next song (gapless playback).
  const players = [$('#audio'), $('#audio2')];
  let audio = players[0];
  let spare = players[1];
  let spareIdx = -1;
  let retiring = false;
  let gapless = true;

  const seek = $('#seek');
  const miniSeek = $('#miniSeek');
  const seeks = [seek, miniSeek];
  const vol = $('#vol');
  const search = $('#search');
  const ctx = $('#ctx');
  let db = { songs: [], playlists: [], settings: defaultSettings() };
  let byId = new Map();
  let view = { type: 'library' };
  let hist = [view];
  let hIdx = 0;
  let libTab = 'songs';
  let searchTerm = '';
  let queue = [];
  let origQueue = null; // the un-shuffled order, while shuffle is on
  let qIndex = -1;
  let panel = null; // 'queue', 'lyrics', or null
  let mini = false;
  let shuffle = false;
  let repeat = 'off'; // 'off', 'all', 'one'
  let dragging = false;
  let selected = new Set();
  let lastSel = null;
  let drag = null;
  let ctxActions = [];
  let errStreak = 0;
  let sleep = null; // { endsAt, endOfSong }
  let sleepTimer = null;
  let fadeTimer = null;
  let lyr = null; // { id, data } where data is undefined (loading), null (none), or parsed lyrics
  let lastUserScroll = 0;
  let editCtx = null;
  let rpcTimer = null;
  let karaokeStage = false; // the singing stage is open
  let kScanned = false;
  let stageRaf = 0;
  let kIdx = -2;
  let kSig = '';
  let kDotsSig = 0;
  let kMonoAt = 0;
  let lyricsJob = null; // progress of a batch lyrics lookup
  let lastRecording = null;
  let graph = null; // the karaoke audio graph, built the first time an effect is needed
  let graphPromise = null;
  const recorder = { active: false, draining: false, chunks: [], songId: null, startedAt: 0, timer: 0, lastT: 0 };
  const micState = { stream: null, src: null, gain: null, analyser: null, monitor: null, buf: null, devices: [] };

  let saveTimer;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.api.save(db), 250);
  };
  const reindex = () => {
    byId = new Map(db.songs.map((s) => [s.id, s]));
  };
  const curPlaylist = () => (view.type === 'playlist' ? db.playlists.find((p) => p.id === view.id) : null);
  const curSong = () => (qIndex >= 0 ? byId.get(queue[qIndex]) : null);
  const songByPath = () => new Map(db.songs.map((s) => [pathKey(s.path), s]));

  // ---------- Sorting ----------
  const sortOf = (scope, p) => (scope === 'playlist' ? (p && p.sort) || { key: 'custom', dir: 1 } : db.settings.sorts[scope] || DEFAULT_SORTS[scope]);
  const isCustomOrder = (p) => !p.sort || (p.sort.key === 'custom' && p.sort.dir > 0);

  function songCmp(key) {
    switch (key) {
      case 'title': return (a, b) => collator.compare(a.title, b.title);
      case 'artist': return (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title);
      case 'album': return (a, b) => collator.compare(a.album || '', b.album || '') || (a.trackNo || 0) - (b.trackNo || 0) || collator.compare(a.title, b.title);
      case 'length': return (a, b) => (a.duration || 0) - (b.duration || 0);
      case 'added': return (a, b) => (a.addedAt || 0) - (b.addedAt || 0);
      case 'track': return (a, b) => (a.trackNo || 999) - (b.trackNo || 999) || collator.compare(a.title, b.title);
      default: return null; // custom order keeps the list as it is
    }
  }
  function sortSongs(list, sort) {
    const cmp = songCmp(sort.key);
    const out = cmp ? list.slice().sort(cmp) : list.slice();
    if (sort.dir < 0) out.reverse();
    return out;
  }
  function sortAlbums(arr, sort) {
    const cmps = {
      name: (a, b) => collator.compare(a.name, b.name),
      artist: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.name, b.name),
      year: (a, b) => (a.year || 0) - (b.year || 0) || collator.compare(a.name, b.name),
      added: (a, b) => a.added - b.added,
    };
    const out = arr.slice().sort(cmps[sort.key] || cmps.name);
    if (sort.dir < 0) out.reverse();
    return out;
  }
  function applySort(scope, p, s) {
    if (scope === 'playlist' && p) p.sort = s;
    else db.settings.sorts[scope] = s;
    save();
    render();
  }
  function setSort(scope, key) {
    const p = scope === 'playlist' ? curPlaylist() : null;
    const cur = sortOf(scope, p);
    applySort(scope, p, cur.key === key ? { key, dir: -cur.dir } : { key, dir: 1 });
  }
  function openSortMenu(scope, btn) {
    const p = scope === 'playlist' ? curPlaylist() : null;
    const cur = sortOf(scope, p);
    const keys = {
      library: ['title', 'artist', 'album', 'length', 'added'],
      albums: ['name', 'artist', 'year', 'added'],
      album: ['track', 'title', 'artist', 'length', 'added'],
      playlist: ['custom', 'title', 'artist', 'album', 'length', 'added'],
    }[scope];
    const items = keys.map((k) => ({ label: SORT_LABELS[k], checked: cur.key === k, run: () => applySort(scope, p, { key: k, dir: cur.key === k ? cur.dir : 1 }) }));
    items.push({ sep: true });
    items.push({ label: 'Reverse order', checked: cur.dir < 0, run: () => applySort(scope, p, { key: cur.key, dir: -cur.dir }) });
    const r = btn.getBoundingClientRect();
    openMenu(items, r.left, r.bottom + 2);
  }
  const sortButton = (scope, p) => {
    const s = sortOf(scope, p);
    return `<button class="btn small" data-action="sort-menu" data-scope="${scope}">Sort: ${esc(SORT_LABELS[s.key])}${s.dir < 0 ? ' (reversed)' : ''}</button>`;
  };
  function listHead(scope, p, thirdColumn) {
    const s = sortOf(scope, p);
    const btn = (k, label) =>
      `<button class="lh ${s.key === k ? 'on' : ''}" data-action="sort" data-scope="${scope}" data-key="${k}">${label}${s.key === k ? (s.dir < 0 ? ' ▼' : ' ▲') : ''}</button>`;
    const third = thirdColumn === 'Album' ? btn('album', 'Album') : esc(thirdColumn);
    return `<div class="list-head"><span></span><span></span><div>${btn('title', 'Title')}${btn('artist', 'Artist')}</div><div>${third}</div><div class="lh-dur">${btn('length', 'Length')}</div></div>`;
  }

  // The songs a playlist shows and plays: its own order or a chosen sort.
  const playlistSongs = (p) => sortSongs(p.songIds.map((id) => byId.get(id)).filter(Boolean), p.sort || { key: 'custom', dir: 1 });
  // Playing a playlist: everything, or only songs in any selected category.
  const playSet = (p) => {
    const live = playlistSongs(p).map((s) => s.id);
    if (!p.activeCats.length) return live;
    return live.filter((id) => (p.songCats[id] || []).some((c) => p.activeCats.includes(c)));
  };

  // ---------- Search and albums ----------
  const matches = (s) =>
    !searchTerm || [s.title, s.artist, s.album, s.albumArtist].some((v) => String(v || '').toLowerCase().includes(searchTerm));
  const libList = () => sortSongs(db.songs.filter(matches), sortOf('library'));

  const albumKey = (s) => (s.album || '') + '||' + (s.albumArtist || s.artist || '');
  function buildAlbums(list) {
    const m = new Map();
    for (const s of list) {
      const key = albumKey(s);
      let a = m.get(key);
      if (!a) {
        a = { key, name: s.album || 'Unknown album', artist: s.albumArtist || s.artist || '', year: 0, cover: '', added: 0, songs: [] };
        m.set(key, a);
      }
      a.songs.push(s);
      if (!a.cover && s.cover) a.cover = s.cover;
      if (!a.year && s.year) a.year = s.year;
      if ((s.addedAt || 0) > a.added) a.added = s.addedAt || 0;
    }
    return [...m.values()];
  }
  const findAlbum = (key) => buildAlbums(db.songs).find((a) => a.key === key);
  const curAlbum = () => (view.type === 'album' ? findAlbum(view.key) : null);
  const albumSongs = (a) => sortSongs(a.songs, sortOf('album'));

  // ---------- Navigation (back/forward) ----------
  function resetSelection() {
    selected = new Set();
    lastSel = null;
  }
  function go(v) {
    if (JSON.stringify(v) !== JSON.stringify(view)) {
      hist = hist.slice(0, hIdx + 1);
      hist.push(v);
      hIdx = hist.length - 1;
      view = v;
      resetSelection();
    }
    render();
  }
  function step(d) {
    const n = hIdx + d;
    if (n < 0 || n >= hist.length) return;
    hIdx = n;
    view = hist[n];
    resetSelection();
    render();
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  function askText(title, initial = '') {
    return new Promise((resolve) => {
      const d = $('#textDialog');
      const input = $('#dlgInput');
      $('#dlgTitle').textContent = title;
      input.value = initial;
      d.returnValue = '';
      d.showModal();
      input.focus();
      input.select();
      d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? input.value.trim() : null), { once: true });
    });
  }
  $('#dlgCancel').addEventListener('click', () => $('#textDialog').close('cancel'));

  // A dialog with your own buttons. Resolves to the clicked button's value, or null if closed with Esc.
  function askChoice(title, message, buttons) {
    return new Promise((resolve) => {
      const d = $('#choiceDialog');
      $('#chTitle').textContent = title;
      $('#chMsg').textContent = message;
      $('#chBtns').innerHTML = buttons
        .map((b, i) => `<button type="submit" class="btn ${b.primary ? 'primary' : ''}" value="${i}">${esc(b.label)}</button>`)
        .join('');
      d.returnValue = '';
      d.showModal();
      d.addEventListener('close', () => resolve(d.returnValue === '' ? null : buttons[Number(d.returnValue)].value), { once: true });
    });
  }

  // ---------- Rendering ----------
  function render() {
    renderSidebar();
    renderTopbar();
    renderMain();
    renderQueue();
  }

  function renderSidebar() {
    $('.nav').classList.toggle('on', view.type === 'library' || view.type === 'album');
    $('#navKaraoke').classList.toggle('on', view.type === 'karaoke');
    $('#playlistList').innerHTML =
      db.playlists
        .map(
          (p) =>
            `<li><button class="pl ${view.type === 'playlist' && view.id === p.id ? 'on' : ''}" data-action="open-playlist" data-id="${p.id}">
              <span>${esc(p.name)}</span><span class="count">${p.songIds.length}</span></button></li>`
        )
        .join('') || '<li class="empty-side">No playlists yet</li>';
  }

  function renderTopbar() {
    $('#btnBack').disabled = hIdx <= 0;
    $('#btnFwd').disabled = hIdx >= hist.length - 1;
  }

  function renderMain() {
    if ((view.type === 'playlist' && !curPlaylist()) || (view.type === 'album' && !curAlbum())) {
      view = { type: 'library' };
      hist[hIdx] = view;
    }
    const main = $('#main');
    const top = main.scrollTop;
    const p = curPlaylist();
    const a = curAlbum();
    main.innerHTML = view.type === 'karaoke' ? karaokeHtml() : p ? playlistHtml(p) : a ? albumHtml(a) : libraryHtml();
    main.scrollTop = top;
    main.classList.toggle('stage-on', karaokeOn());
    markNow();
    applySelection();
    afterMainRender();
  }

  // A library or album row: play, cover, title and artist, extra text, length.
  function libRow(s, extra, playAction = 'play-row', inline = '') {
    return `<div class="row" draggable="true" data-id="${s.id}">
      <button class="play" data-action="${playAction}" data-id="${s.id}" title="Play" aria-label="Play ${esc(s.title)}">${ICON.play}</button>
      ${coverEl(s.cover, 'sm')}
      <div class="meta"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist)}${inline ? `<span class="cats-inline"> - ${esc(inline)}</span>` : ''}</div></div>
      <div class="alb">${esc(extra)}</div>
      <div class="dur">${s.duration ? fmt(s.duration) : ''}</div>
    </div>`;
  }

  function libraryHtml() {
    const list = libList();
    const scope = libTab === 'albums' ? 'albums' : 'library';
    const tabs = `<div class="tabs">
      <button class="btn ${libTab === 'songs' ? 'on' : ''}" data-action="tab" data-tab="songs">Songs</button>
      <button class="btn ${libTab === 'albums' ? 'on' : ''}" data-action="tab" data-tab="albums">Albums</button>
      <span class="grow"></span>${sortButton(scope)}
    </div>`;
    const sub = searchTerm ? `${list.length} of ${plural(db.songs.length, 'song')}` : plural(db.songs.length, 'song');
    const head = `<header class="head">
        <div class="info">
          <h1>Library</h1><div class="sub">${sub}</div>
          <div class="actions">
            <button class="btn primary" data-action="add-files">Add files</button>
            <button class="btn" data-action="add-folder">Add folder</button>
            <button class="btn" data-action="refresh" ${db.songs.length ? '' : 'disabled'}>Refresh metadata</button>
            <button class="btn" data-action="io-menu">Import / export</button>
          </div>
        </div>
      </header>`;

    if (!db.songs.length) {
      return head + `<div class="empty"><p>Your library is empty.</p><p>Add files or a whole folder, drag them in from Explorer, or import a backup.</p></div>`;
    }
    if (!list.length) {
      return head + tabs + `<div class="empty"><p>No songs match "${esc(searchTerm)}".</p><p>Try a different title, artist, or album.</p></div>`;
    }
    if (libTab === 'albums') {
      const cards = sortAlbums(buildAlbums(list), sortOf('albums'))
        .map(
          (a) => `<button class="card" data-action="open-album" data-key="${esc(a.key)}">
            ${coverEl(a.cover, 'fill')}
            <div class="cn">${esc(a.name)}</div>
            <div class="cs">${esc(a.artist)}</div>
            <div class="cs">${a.year ? a.year : ''}</div>
          </button>`
        )
        .join('');
      return head + tabs + `<div class="grid">${cards}</div>`;
    }
    return head + tabs + listHead('library', null, 'Album') + `<div class="list">${list.map((s) => libRow(s, s.album)).join('')}</div>`;
  }

  function albumHtml(a) {
    const bits = [a.artist, a.year || '', plural(a.songs.length, 'song')].filter(Boolean).join(', ');
    return `<header class="head">
        ${coverEl(a.cover, 'lg')}
        <div class="info">
          <h1>${esc(a.name)}</h1><div class="sub">${esc(bits)}</div>
          <div class="actions"><button class="btn primary" data-action="play-album">Play album</button>${sortButton('album')}</div>
        </div>
      </header>
      ${listHead('album', null, 'Genre')}<div class="list">${albumSongs(a).map((s) => libRow(s, s.genre)).join('')}</div>`;
  }

  // Playlist cover: a 2x2 mosaic when there are 4 different covers, otherwise the first one.
  function mosaicEl(ids) {
    const covers = [...new Set(ids.map((id) => byId.get(id)).filter((s) => s && s.cover).map((s) => s.cover))];
    if (covers.length >= 4) {
      return `<div class="cover lg quad">${covers
        .slice(0, 4)
        .map((c) => `<img src="${esc(fileUrl(c))}" alt="" loading="lazy">`)
        .join('')}</div>`;
    }
    return coverEl(covers[0] || '', 'lg');
  }

  function playlistHtml(p) {
    const set = playSet(p);
    const playLabel = p.activeCats.length ? `Play selected categories (${set.length})` : `Play all (${set.length})`;
    const sorted = !isCustomOrder(p);

    const chips = p.categories
      .map((c) => {
        const n = p.songIds.filter((id) => (p.songCats[id] || []).includes(c.id)).length;
        const on = p.activeCats.includes(c.id);
        return `<span class="chip">
          <button class="cat ${on ? 'on' : ''}" data-action="toggle-active" data-cat="${c.id}" aria-pressed="${on}">${esc(c.name)} <em>${n}</em></button>
          <button class="chip-x" data-action="delete-cat" data-cat="${c.id}" title="Delete category" aria-label="Delete category ${esc(c.name)}">${ICON.close}</button>
        </span>`;
      })
      .join('');

    const rows = playlistSongs(p)
      .map((s) => {
        const names = p.categories.filter((c) => (p.songCats[s.id] || []).includes(c.id)).map((c) => c.name);
        return `<div class="row" draggable="true" data-id="${s.id}">
          <button class="play" data-action="play-row" data-id="${s.id}" title="Play" aria-label="Play ${esc(s.title)}">${ICON.play}</button>
          ${coverEl(s.cover, 'sm')}
          <div class="meta"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist)}${names.length ? `<span class="cats-inline"> - ${esc(names.join(', '))}</span>` : ''}</div></div>
          <div class="alb">${esc(names.join(', '))}</div>
          <div class="dur">${s.duration ? fmt(s.duration) : ''}</div>
        </div>`;
      })
      .join('');

    const sub = plural(p.songIds.length, 'song') + (sorted ? `, sorted by ${SORT_LABELS[p.sort.key].toLowerCase()}` : '');
    return `<header class="head">
        ${mosaicEl(p.songIds)}
        <div class="info">
          <h1>${esc(p.name)}</h1><div class="sub">${esc(sub)}</div>
          <div class="actions">
            <button class="btn primary" data-action="play-set" ${set.length ? '' : 'disabled'}>${playLabel}</button>
            <button class="btn" data-action="rename-playlist">Rename</button>
            <button class="btn" data-action="export-playlist">Export</button>
            <button class="btn" data-action="delete-playlist">Delete</button>
            ${sortButton('playlist', p)}
          </div>
        </div>
      </header>
      <section class="cats-bar">
        <h2>Categories</h2>
        <div class="chips">${chips}<button class="cat add" data-action="new-cat">+ New category</button></div>
      </section>
      <p class="cat-hint">${
        p.categories.length
          ? 'Select categories to play only those songs. Right-click songs to file them, or drag songs onto a category.'
          : 'Make a category, like "gym" or "sad", then right-click songs to file them in it.'
      }${sorted ? ' Choose Sort, then Custom order to drag songs around.' : ''}</p>` +
      (p.songIds.length
        ? listHead('playlist', p, 'Categories') + `<div class="list">${rows}</div>`
        : `<div class="empty"><p>This playlist is empty.</p><p>Right-click a song in the library and choose "Add to playlist", or drag songs onto this playlist in the sidebar.</p></div>`);
  }

  // The right-hand panel shows either the queue or the lyrics.
  function renderQueue() {
    const q = $('#queuePanel');
    q.hidden = panel !== 'queue';
    $('#lyricsPanel').hidden = panel !== 'lyrics';
    $('#app').classList.toggle('with-panel', !!panel);
    $('#btnQueue').setAttribute('aria-pressed', String(panel === 'queue'));
    $('#btnLyrics').setAttribute('aria-pressed', String(panel === 'lyrics'));
    if (panel !== 'queue') return;
    q.innerHTML =
      '<h2>Queue</h2>' +
      (queue.length
        ? queue
            .map((id, i) => {
              const s = byId.get(id);
              if (!s) return '';
              return `<button class="qrow ${i === qIndex ? 'now' : ''}" draggable="true" data-i="${i}">
                ${coverEl(s.cover, 'xs')}
                <span class="qtxt"><span class="t">${esc(s.title)}</span><span class="a">${esc(s.artist)}</span></span></button>`;
            })
            .join('')
        : '<div class="empty"><p>Nothing queued.</p><p>Play a song or a playlist to fill it.</p></div>');
  }

  function setPanel(name) {
    panel = panel === name ? null : name;
    renderQueue();
    if (panel === 'lyrics') renderLyrics();
  }

  function markNow() {
    const cur = qIndex >= 0 ? queue[qIndex] : null;
    $$('.row').forEach((r) => r.classList.toggle('now', r.dataset.id === cur));
  }

  function setNowPlaying(s) {
    const title = s ? s.title : 'Nothing playing';
    const artist = s ? s.artist : '';
    $('#npTitle').textContent = title;
    $('#npArtist').textContent = artist;
    $('#miniTitle').textContent = title;
    $('#miniArtist').textContent = artist;
    $('#sideArt').innerHTML = s ? coverEl(s.cover, 'fill') : '';
    $('#miniArt').innerHTML = coverEl(s ? s.cover : '', 'fill');
    document.title = s ? `${s.title} - ${s.artist}` : 'Evilfy';
  }

  // ---------- Selection ----------
  const rowIds = () => $$('.list .row').map((r) => r.dataset.id);
  const orderedSelected = () => rowIds().filter((id) => selected.has(id));

  function applySelection() {
    $$('.list .row').forEach((r) => r.classList.toggle('sel', selected.has(r.dataset.id)));
  }
  function clearSelection() {
    if (!selected.size) return;
    resetSelection();
    applySelection();
  }
  function selectRow(row, e) {
    const id = row.dataset.id;
    const ids = rowIds();
    if (e.shiftKey && lastSel && ids.includes(lastSel)) {
      const a = ids.indexOf(lastSel);
      const b = ids.indexOf(id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      selected = e.ctrlKey || e.metaKey ? new Set([...selected, ...range]) : new Set(range);
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(selected);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      selected = n;
      lastSel = id;
    } else {
      selected = new Set([id]);
      lastSel = id;
    }
    applySelection();
  }

  // ---------- Library and playlist changes ----------
  // Adds songs that aren't in the library yet (matched by file path). Returns the new ones.
  function mergeSongs(found) {
    const have = new Set(db.songs.map((s) => pathKey(s.path)));
    const added = [];
    for (const f of found) {
      const k = pathKey(f.path);
      if (have.has(k)) continue;
      const s = { id: uid(), addedAt: Date.now(), ...f };
      db.songs.push(s);
      have.add(k);
      added.push(s);
    }
    if (added.length) reindex();
    return added;
  }

  function addSongs(found) {
    if (!found || !found.length) return;
    const added = mergeSongs(found);
    save();
    render();
    toast(added.length ? `Added ${plural(added.length, 'song')}` : 'Those songs are already in your library');
  }

  function removeSongFromLibrary(id) {
    db.songs = db.songs.filter((s) => s.id !== id);
    db.playlists.forEach((p) => {
      p.songIds = p.songIds.filter((x) => x !== id);
      delete p.songCats[id];
    });
  }

  function removeSongsFromLibrary(ids) {
    const one = ids.length === 1 ? byId.get(ids[0]) : null;
    const what = one ? `"${one.title}"` : plural(ids.length, 'song');
    if (!confirm(`Remove ${what} from the library? The files stay on your computer.`)) return;
    ids.forEach(removeSongFromLibrary);
    reindex();
    resetSelection();
    save();
    render();
  }

  function removeFromPlaylist(p, ids) {
    p.songIds = p.songIds.filter((x) => !ids.includes(x));
    ids.forEach((id) => delete p.songCats[id]);
    resetSelection();
    save();
    render();
  }

  function addToPlaylist(ids, pid) {
    const p = db.playlists.find((x) => x.id === pid);
    if (!p) return;
    const fresh = ids.filter((id) => !p.songIds.includes(id));
    if (!fresh.length) {
      toast(`Already in "${p.name}".`);
      return;
    }
    p.songIds.push(...fresh);
    save();
    render();
    schedulePreload();
    toast(`Added ${plural(fresh.length, 'song')} to "${p.name}"`);
  }

  const newPlaylistObj = (name) => ({ id: uid(), name, songIds: [], categories: [], songCats: {}, activeCats: [] });
  function uniquePlaylistName(name) {
    const taken = new Set(db.playlists.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`.toLowerCase())) n++;
    return `${name} (${n})`;
  }
  const normalizePlaylist = (p) => ({
    ...p,
    id: p.id || uid(),
    name: p.name || 'Playlist',
    songIds: p.songIds || [],
    categories: p.categories || [],
    songCats: p.songCats || {},
    activeCats: p.activeCats || [],
  });

  async function newPlaylistWith(ids) {
    const name = await askText('New playlist');
    if (!name) return;
    const np = newPlaylistObj(name);
    db.playlists.push(np);
    addToPlaylist(ids, np.id);
  }

  async function renamePlaylist(p) {
    const name = await askText('Rename playlist', p.name);
    if (!name) return;
    p.name = name;
    save();
    render();
  }

  function deletePlaylist(p) {
    if (!confirm(`Delete "${p.name}"? Your songs stay in the library.`)) return;
    db.playlists = db.playlists.filter((x) => x.id !== p.id);
    save();
    if (view.type === 'playlist' && view.id === p.id) go({ type: 'library' });
    else render();
  }

  function setCategory(p, ids, catId, on) {
    for (const id of ids) {
      const mine = p.songCats[id] || [];
      const has = mine.includes(catId);
      if (on && !has) p.songCats[id] = [...mine, catId];
      else if (!on && has) p.songCats[id] = mine.filter((x) => x !== catId);
    }
    save();
    render();
  }

  async function newCategoryWith(p, ids) {
    const name = await askText('New category');
    if (!name) return;
    if (p.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      toast(`"${name}" already exists in this playlist.`);
      return;
    }
    const c = { id: uid(), name };
    p.categories.push(c);
    if (ids && ids.length) setCategory(p, ids, c.id, true);
    else {
      save();
      render();
    }
  }

  const TAG_FIELDS = ['title', 'artist', 'albumArtist', 'album', 'year', 'trackNo', 'genre', 'cover'];

  async function refreshMetadata(list = db.songs, opts = {}) {
    if (!list.length) return;
    if (!opts.quiet) toast('Reading tags and covers...');
    const results = await window.api.refresh(list.map((s) => ({ id: s.id, path: s.path })));
    let n = 0;
    for (const r of results) {
      const s = byId.get(r.id);
      if (!s) continue;
      // Fields you edited by hand are left alone.
      for (const f of TAG_FIELDS) if (!(s.edited && s.edited[f])) s[f] = r[f];
      s.duration = r.duration || s.duration;
      n++;
    }
    save();
    render();
    const cur = curSong();
    if (cur) setNowPlaying(cur);
    if (!opts.quiet) {
      const missing = list.length - n;
      toast(`Updated ${plural(n, 'song')}${missing ? `, ${missing} not found on disk` : ''}`);
    }
  }

  function showInfo(s) {
    const rows = [
      ['Title', s.title],
      ['Artist', s.artist],
      ['Album artist', s.albumArtist],
      ['Album', s.album],
      ['Year', s.year || ''],
      ['Track number', s.trackNo || ''],
      ['Genre', s.genre],
      ['Length', s.duration ? fmt(s.duration) : ''],
      ['File', s.path],
    ].filter((r) => r[1] !== '' && r[1] != null);
    $('#infoBody').innerHTML =
      `<div class="info-top">${coverEl(s.cover, 'lg')}</div>` +
      `<table>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
    $('#infoDialog').showModal();
  }

  // ---------- Metadata editor ----------
  const ED_FIELDS = [
    ['title', 'Title'],
    ['artist', 'Artist'],
    ['albumArtist', 'Album artist'],
    ['album', 'Album'],
    ['year', 'Year'],
    ['trackNo', 'Track number'],
    ['genre', 'Genre'],
  ];

  function openEditor(ids) {
    const songs = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!songs.length) return;
    const multi = songs.length > 1;
    editCtx = { ids: songs.map((s) => s.id), touched: new Set(), cover: undefined, lyricsTouched: false };
    const common = (f) => {
      const vals = songs.map((s) => s[f] ?? '');
      return vals.every((v) => String(v) === String(vals[0])) ? vals[0] : null;
    };
    $('#edTitle').textContent = multi ? `Edit info (${plural(songs.length, 'song')})` : 'Edit info';
    $('#edFields').innerHTML = ED_FIELDS.map(([f, label]) => {
      const c = common(f);
      const numeric = f === 'year' || f === 'trackNo';
      const val = c === null || c === 0 ? '' : c;
      return `<label for="ed-${f}">${esc(label)}</label>
        <input id="ed-${f}" data-f="${f}" type="${numeric ? 'number' : 'text'}" ${numeric ? 'min="0" step="1"' : ''}
          value="${esc(val)}" placeholder="${c === null ? 'Different values (leave to keep)' : ''}" autocomplete="off">`;
    }).join('');
    $('#edLyricsWrap').hidden = multi;
    $('#edLyrics').value = multi ? '' : songs[0].lyrics || '';
    const covers = songs.map((s) => s.cover || '');
    $('#edCover').innerHTML = coverEl(covers.find(Boolean) || '', 'lg');
    const d = $('#editDialog');
    d.returnValue = '';
    d.showModal();
    const first = $('#ed-title');
    if (first) first.focus();
  }

  function applyEdit() {
    const e = editCtx;
    editCtx = null;
    if (!e) return;
    const songs = e.ids.map((id) => byId.get(id)).filter(Boolean);
    const playingId = qIndex >= 0 ? queue[qIndex] : null;
    for (const s of songs) {
      s.edited = s.edited || {};
      for (const f of e.touched) {
        const raw = $(`#ed-${f}`).value.trim();
        if (f === 'year' || f === 'trackNo') s[f] = Math.max(0, Math.floor(Number(raw) || 0));
        else if (f === 'title') {
          if (!raw) continue; // a song needs a title
          s.title = raw;
        } else if (f === 'artist') s.artist = raw || 'Unknown artist';
        else s[f] = raw;
        s.edited[f] = true;
      }
      if (e.cover !== undefined) {
        s.cover = e.cover;
        s.edited.cover = true;
      }
      if (e.lyricsTouched && songs.length === 1) s.lyrics = $('#edLyrics').value;
    }
    save();
    render();
    if (playingId && e.ids.includes(playingId)) {
      const s = byId.get(playingId);
      setNowPlaying(s);
      loadLyrics(s);
      rpcPush();
    }
    toast(`Updated ${plural(songs.length, 'song')}`);
  }

  $('#edFields').addEventListener('input', (e) => {
    const f = e.target.dataset && e.target.dataset.f;
    if (f && editCtx) editCtx.touched.add(f);
  });
  $('#edLyrics').addEventListener('input', () => {
    if (editCtx) editCtx.lyricsTouched = true;
  });
  $('#edPick').addEventListener('click', async () => {
    const p = await window.api.pickCover();
    if (p && editCtx) {
      editCtx.cover = p;
      $('#edCover').innerHTML = coverEl(p, 'lg');
    }
  });
  $('#edClear').addEventListener('click', () => {
    if (!editCtx) return;
    editCtx.cover = '';
    $('#edCover').innerHTML = coverEl('', 'lg');
  });
  $('#edCancel').addEventListener('click', () => $('#editDialog').close('cancel'));
  $('#editDialog').addEventListener('close', () => {
    if ($('#editDialog').returnValue === 'ok') applyEdit();
    else editCtx = null;
  });

  // ---------- Lyrics ----------
  // Understands LRC files ([mm:ss.xx] lines, [offset:] tag) and plain text.
  function parseLyrics(text) {
    const lines = [];
    const plain = [];
    let offset = 0;
    for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = raw.match(/^((?:\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
      if (m) {
        const words = m[2].trim();
        for (const st of m[1].matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
          const t = Number(st[1]) * 60000 + Number(st[2]) * 1000 + (st[3] ? Math.round(Number('0.' + st[3]) * 1000) : 0);
          lines.push({ t, text: words });
        }
        continue;
      }
      const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) {
        offset = Number(off[1]);
        continue;
      }
      if (/^\s*\[[a-z]{2,}:[^\]]*\]\s*$/i.test(raw)) continue; // other LRC tags like [ar:...]
      plain.push(raw);
    }
    if (lines.length) {
      lines.forEach((l) => (l.t -= offset));
      lines.sort((a, b) => a.t - b.t);
      return { kind: 'lrc', lines };
    }
    const t = plain.join('\n').trim();
    return t ? { kind: 'plain', text: t } : null;
  }

  async function loadLyrics(s) {
    lyr = { id: s.id, data: undefined, cur: -1 };
    let text = s.lyrics || '';
    if (!text) {
      try {
        const r = await window.api.findLyrics(s.path);
        text = (r && r.text) || '';
      } catch {
        text = '';
      }
    }
    if (!lyr || lyr.id !== s.id) return; // the song changed while we were reading
    lyr.data = parseLyrics(text);
    renderLyrics();
    updateLyricHighlight(true);
  }

  function renderLyrics() {
    if (panel !== 'lyrics') return;
    const lp = $('#lyricsPanel');
    const s = curSong();
    let body = '';
    if (!s) {
      body = '<div class="empty"><p>Nothing playing.</p><p>Play a song to see its lyrics here.</p></div>';
    } else if (lyr && lyr.id === s.id && lyr.data === null) {
      body =
        '<div class="empty"><p>No lyrics for this song.</p><p>Right-click it and choose "Edit info" to paste some, or put a .lrc file with the same name next to it.</p></div>';
    } else if (lyr && lyr.id === s.id && lyr.data) {
      body =
        lyr.data.kind === 'lrc'
          ? lyr.data.lines.map((l, i) => `<div class="ly-line" data-t="${l.t}" data-n="${i}">${l.text ? esc(l.text) : '&nbsp;'}</div>`).join('')
          : `<pre class="ly-plain">${esc(lyr.data.text)}</pre>`;
    }
    lp.innerHTML = `<h2>Lyrics</h2><div class="ly-song">${s ? esc(`${s.title} - ${s.artist}`) : ''}</div>${body}`;
  }

  function currentLine() {
    if (!lyr || !lyr.data || lyr.data.kind !== 'lrc') return -1;
    const t = audio.currentTime * 1000 - lyricOffset();
    const L = lyr.data.lines;
    let lo = 0;
    let hi = L.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function updateLyricHighlight(force) {
    const n = currentLine();
    if (!force && lyr && n === lyr.cur) return;
    if (lyr) lyr.cur = n;
    $('#miniLyric').textContent = lyr && lyr.data && lyr.data.kind === 'lrc' && n >= 0 ? lyr.data.lines[n].text : '';
    if (panel === 'lyrics') {
      const els = $$('#lyricsPanel .ly-line');
      els.forEach((el, i) => el.classList.toggle('cur', i === n));
      const el = els[n];
      if (el && Date.now() - lastUserScroll > 3000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  $('#lyricsPanel').addEventListener('wheel', () => (lastUserScroll = Date.now()), { passive: true });
  $('#lyricsPanel').addEventListener('click', (e) => {
    const line = e.target.closest('.ly-line');
    if (!line || qIndex < 0) return;
    audio.currentTime = Number(line.dataset.t) / 1000 + 0.01;
    lastUserScroll = 0;
    updateLyricHighlight(true);
  });

  // ---------- Playback and queue ----------
  function playQueue(ids, start) {
    if (shuffle && ids.length > 1 && ids[start] !== undefined) {
      origQueue = ids.slice();
      queue = [ids[start], ...shuffled(ids.filter((_, i) => i !== start))];
      qIndex = 0;
    } else {
      origQueue = null;
      queue = ids.slice();
      qIndex = start;
    }
    loadCurrent();
  }

  // Plays a song the way the current page would: playlists respect the selected categories and sort.
  function playInContext(id) {
    const p = curPlaylist();
    if (p) {
      let set = playSet(p);
      let idx = set.indexOf(id);
      if (idx < 0) {
        set = playlistSongs(p).map((s) => s.id);
        idx = set.indexOf(id);
      }
      return playQueue(set, idx);
    }
    const a = curAlbum();
    if (a) {
      const ids = albumSongs(a).map((s) => s.id);
      return playQueue(ids, ids.indexOf(id));
    }
    const ids = libList().map((s) => s.id);
    playQueue(ids, ids.indexOf(id));
  }

  // Adds songs to the queue, either right after the current song or at the end.
  function enqueue(ids, atNext) {
    if (qIndex < 0) {
      playQueue(ids, 0);
      return;
    }
    if (atNext) queue.splice(qIndex + 1, 0, ...ids);
    else queue.push(...ids);
    if (origQueue) {
      const at = atNext ? origQueue.indexOf(queue[qIndex]) + 1 : origQueue.length;
      origQueue.splice(at, 0, ...ids);
    }
    renderQueue();
    schedulePreload();
    toast(atNext ? `${plural(ids.length, 'song')} will play next` : `Added ${plural(ids.length, 'song')} to the queue`);
  }

  function removeFromQueue(i) {
    const [gone] = queue.splice(i, 1);
    if (origQueue) {
      const at = origQueue.indexOf(gone);
      if (at >= 0) origQueue.splice(at, 1);
    }
    if (i < qIndex) qIndex--;
    else if (i === qIndex) {
      if (qIndex >= queue.length) return stopAll();
      return loadCurrent();
    }
    renderQueue();
    markNow();
    schedulePreload();
  }

  // Moves queue entry `from` so it sits before the entry that was at `before`.
  function moveInQueue(from, before) {
    const cur = qIndex;
    const [item] = queue.splice(from, 1);
    const ins = before > from ? before - 1 : before;
    queue.splice(ins, 0, item);
    if (cur === from) qIndex = ins;
    else if (from < cur) qIndex = ins < cur ? cur : cur - 1;
    else qIndex = ins <= cur ? cur + 1 : cur;
    renderQueue();
    markNow();
    schedulePreload();
  }

  function reorderPlaylist(p, ids, targetId, after) {
    const moving = new Set(ids);
    if (moving.has(targetId)) return;
    const rest = p.songIds.filter((x) => !moving.has(x));
    let at = rest.indexOf(targetId);
    if (at < 0) return;
    if (after) at++;
    rest.splice(at, 0, ...p.songIds.filter((x) => moving.has(x)));
    p.songIds = rest;
  }

  function loadCurrent() {
    while (qIndex < queue.length && !byId.has(queue[qIndex])) qIndex++;
    if (qIndex >= queue.length) return stopAll();
    const s = byId.get(queue[qIndex]);
    audio.src = fileUrl(s.path);
    audio.play().catch(() => {});
    applyLoop();
    setNowPlaying(s);
    markNow();
    renderQueue();
    loadLyrics(s);
    onSongStart(s);
    setTimeout(schedulePreload, 300);
  }

  function stopAll() {
    qIndex = -1;
    retiring = false;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    clearSpare();
    setNowPlaying(null);
    seeks.forEach((r) => {
      r.value = 0;
      setFill(r);
    });
    $('#cur').textContent = '0:00';
    $('#tot').textContent = '0:00';
    lyr = null;
    $('#miniLyric').textContent = '';
    onPlaybackStopped();
    markNow();
    renderQueue();
    renderLyrics();
    syncTransport();
    rpcPush();
  }

  function next() {
    if (qIndex < 0) return;
    if (qIndex >= queue.length - 1) {
      if (repeat === 'all' && queue.length) {
        qIndex = 0;
        return loadCurrent();
      }
      return stopAll();
    }
    qIndex++;
    loadCurrent();
  }

  function prev() {
    if (qIndex < 0) return;
    if (audio.currentTime > 3 || qIndex === 0) {
      audio.currentTime = 0;
      return;
    }
    qIndex--;
    loadCurrent();
  }

  function togglePlay() {
    if (qIndex < 0) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  // ---------- Gapless playback ----------
  // Which queue position plays after the current one (-1 if playback should just stop).
  function nextIndex() {
    if (qIndex < 0 || !queue.length || repeat === 'one') return -1;
    for (let step = 1; step <= queue.length; step++) {
      let idx = qIndex + step;
      if (idx >= queue.length) {
        if (repeat !== 'all') return -1;
        idx %= queue.length;
      }
      if (byId.has(queue[idx])) return idx;
    }
    return -1;
  }

  function clearSpare() {
    spare.pause();
    spare.removeAttribute('src');
    spare.load();
    spare.dataset.songId = '';
    spareIdx = -1;
  }

  // Loads the next song into the idle player so it can start the instant this one ends.
  function schedulePreload() {
    if (retiring) return;
    if (!gapless) {
      if (spareIdx >= 0 || spare.src) clearSpare();
      return;
    }
    const idx = nextIndex();
    if (idx < 0) {
      if (spareIdx >= 0 || spare.src) clearSpare();
      return;
    }
    const id = queue[idx];
    if (spare.dataset.songId === id) {
      spareIdx = idx;
      return;
    }
    const s = byId.get(id);
    spare.dataset.songId = id;
    spare.preload = 'auto';
    spare.src = fileUrl(s.path);
    spare.load();
    spareIdx = idx;
  }

  function advanceGapless() {
    const s = byId.get(queue[spareIdx]);
    if (!s) return;
    const old = audio;
    qIndex = spareIdx;
    spare.volume = old.volume;
    audio = spare;
    spare = old;
    spareIdx = -1;
    retiring = true;
    audio.play().catch(() => {});
    applyLoop();
    setNowPlaying(s);
    markNow();
    renderQueue();
    loadLyrics(s);
    onSongStart(s);
    $('#tot').textContent = fmt(audio.duration);
    if (!s.duration && isFinite(audio.duration)) {
      s.duration = audio.duration;
      save();
    }
    // Let the old player finish its last few milliseconds, then reset it and preload what comes next.
    setTimeout(() => {
      old.pause();
      old.removeAttribute('src');
      old.load();
      old.dataset.songId = '';
      retiring = false;
      schedulePreload();
    }, 250);
  }

  function gaplessTick() {
    if (!gapless || retiring || qIndex < 0 || spareIdx < 0 || audio.paused || repeat === 'one') return;
    if (sleep && sleep.endOfSong) return;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    const left = audio.duration - audio.currentTime;
    if (left <= 0.06 && left >= 0 && spare.readyState >= 3 && !spare.error) advanceGapless();
  }
  setInterval(gaplessTick, 25);

  // Repeat one loops the song without a gap (unless a sleep timer is waiting for the song to end).
  function applyLoop() {
    audio.loop = repeat === 'one' && !(sleep && sleep.endOfSong);
    spare.loop = false;
  }

  // ---------- Shuffle and repeat ----------
  function setShuffle(on) {
    if (on === shuffle) return;
    shuffle = on;
    db.settings.shuffle = on;
    save();
    if (on) {
      if (queue.length > 1 && qIndex >= 0) {
        origQueue = queue.slice();
        const cur = queue[qIndex];
        queue = [cur, ...shuffled(queue.filter((_, i) => i !== qIndex))];
        qIndex = 0;
      }
    } else if (origQueue) {
      const cur = qIndex >= 0 ? queue[qIndex] : null;
      queue = origQueue;
      origQueue = null;
      const idx = cur ? queue.indexOf(cur) : -1;
      qIndex = cur ? (idx >= 0 ? idx : 0) : -1;
    }
    syncTransport();
    renderQueue();
    markNow();
    schedulePreload();
  }

  function cycleRepeat() {
    repeat = { off: 'all', all: 'one', one: 'off' }[repeat];
    db.settings.repeat = repeat;
    save();
    syncTransport();
    schedulePreload();
  }

  // Keeps the buttons in the player bar and the mini player showing the same state.
  function syncTransport() {
    const label = repeat === 'off' ? 'Repeat' : repeat === 'all' ? 'Repeat all' : 'Repeat one';
    for (const b of [$('#btnRepeat'), $('#btnMiniRepeat')]) {
      b.textContent = label;
      b.setAttribute('aria-pressed', String(repeat !== 'off'));
    }
    for (const b of [$('#btnShuffle'), $('#btnMiniShuffle')]) b.setAttribute('aria-pressed', String(shuffle));
    for (const b of [$('#btnPlay'), $('#btnMiniPlay')]) {
      b.innerHTML = audio.paused ? ICON.play : ICON.pause;
      b.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
    }
    applyLoop();
  }

  // ---------- Sleep timer ----------
  const sleepBtn = $('#btnSleep');

  function updateSleepBtn() {
    sleepBtn.setAttribute('aria-pressed', String(!!sleep));
    if (!sleep) sleepBtn.textContent = 'Sleep';
    else if (sleep.fading) sleepBtn.textContent = 'Sleep: fading';
    else if (sleep.endOfSong) sleepBtn.textContent = 'Sleep: song end';
    else sleepBtn.textContent = `Sleep ${fmt(Math.max(0, Math.ceil((sleep.endsAt - Date.now()) / 1000)))}`;
    applyLoop();
  }

  function stopFade() {
    if (!fadeTimer) return;
    clearInterval(fadeTimer);
    fadeTimer = null;
    audio.volume = db.settings.volume ?? 0.8;
  }

  function cancelSleep() {
    clearInterval(sleepTimer);
    sleepTimer = null;
    stopFade();
    sleep = null;
    updateSleepBtn();
  }

  function startSleep(minutes) {
    cancelSleep();
    sleep = { endsAt: Date.now() + minutes * 60000, endOfSong: false };
    sleepTimer = setInterval(sleepTick, 500);
    updateSleepBtn();
    toast(`Sleep timer set for ${plural(minutes, 'minute')}`);
  }

  function sleepAtSongEnd() {
    cancelSleep();
    sleep = { endsAt: 0, endOfSong: true };
    updateSleepBtn();
    toast('Playback will stop when this song ends');
  }

  function sleepTick() {
    if (!sleep || sleep.endOfSong || sleep.fading) return;
    if (sleep.endsAt - Date.now() <= 0) beginFade();
    else updateSleepBtn();
  }

  // Fades the volume out over 10 seconds, then pauses and restores the volume.
  function beginFade() {
    clearInterval(sleepTimer);
    sleepTimer = null;
    if (audio.paused) {
      sleep = null;
      updateSleepBtn();
      return;
    }
    sleep.fading = true;
    updateSleepBtn();
    const startVol = audio.volume;
    const t0 = Date.now();
    fadeTimer = setInterval(() => {
      const f = Math.min(1, (Date.now() - t0) / 10000);
      audio.volume = startVol * (1 - f);
      if (f >= 1) {
        clearInterval(fadeTimer);
        fadeTimer = null;
        audio.pause();
        audio.volume = db.settings.volume ?? 0.8;
        sleep = null;
        updateSleepBtn();
        toast('Sleep timer: playback paused');
      }
    }, 100);
  }

  function finishSleepAtSongEnd() {
    sleep = null;
    updateSleepBtn();
    toast('Sleep timer: stopped at the end of the song');
  }

  function openSleepMenu() {
    const r = sleepBtn.getBoundingClientRect();
    const items = [15, 30, 45, 60].map((m) => ({ label: `${m} minutes`, run: () => startSleep(m) }));
    items.push({
      label: 'Custom...',
      run: async () => {
        const v = await askText('Sleep timer (minutes)');
        if (v === null) return;
        const m = Math.round(Number(v));
        if (!(m >= 1 && m <= 720)) {
          toast('Enter a number of minutes from 1 to 720.');
          return;
        }
        startSleep(m);
      },
    });
    items.push({ label: 'End of this song', disabled: qIndex < 0, run: sleepAtSongEnd });
    if (sleep) {
      items.push({ sep: true });
      items.push({
        label: 'Cancel timer',
        danger: true,
        run: () => {
          cancelSleep();
          toast('Sleep timer cancelled');
        },
      });
    }
    openMenu(items, r.left, r.top);
  }

  // ---------- Mini player ----------
  async function setMini(on) {
    mini = on;
    if (on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    closeMenu();
    document.body.classList.toggle('mini', on);
    await window.api.setMini(on);
  }

  // ---------- Discord Rich Presence ----------
  // Tells Discord what is playing. Updates are batched so they stay well under Discord's rate limit.
  function rpcPush() {
    if (!db.settings.rpcEnabled) return;
    clearTimeout(rpcTimer);
    rpcTimer = setTimeout(() => {
      const s = curSong();
      if (!s || audio.paused || !isFinite(audio.duration) || audio.duration <= 0) {
        window.api.rpcActivity(null);
        return;
      }
      const rate = audio.playbackRate || 1;
      const start = Date.now() - (audio.currentTime / rate) * 1000;
      window.api.rpcActivity({ details: s.title, state: s.artist, start, end: start + (audio.duration / rate) * 1000, largeText: s.album || 'Evilfy' });
    }, 1200);
  }

  const RPC_TEXT = {
    off: 'Off',
    connected: 'Connected to Discord',
    waiting: 'Waiting for Discord. Is the desktop app open?',
    missing: 'Discord support is not installed. Run npm install again.',
    'bad-id': 'That does not look like a valid Application ID (it should be numbers only).',
  };
  const showRpcStatus = (s) => {
    $('#rpcStatus').textContent = 'Status: ' + (RPC_TEXT[s] || s);
  };

  // ---------- Settings ----------
  function openSettings() {
    $('#setGapless').checked = gapless;
    $('#setRpc').checked = !!db.settings.rpcEnabled;
    $('#setRpcId').value = db.settings.rpcClientId || DEFAULT_RPC_ID;
    $('#setOnlineLyrics').checked = !!db.settings.onlineLyrics;
    $('#setRecAdd').checked = db.settings.recAddToLibrary !== false;
    $('#setRecFolder').value = db.settings.recordFolder || '';
    window.api.rpcStatus().then(showRpcStatus);
    const d = $('#settingsDialog');
    d.returnValue = '';
    d.showModal();
  }

  function applySettings() {
    gapless = $('#setGapless').checked;
    db.settings.gapless = gapless;
    db.settings.rpcEnabled = $('#setRpc').checked;
    db.settings.rpcClientId = $('#setRpcId').value.trim() || DEFAULT_RPC_ID;
    db.settings.onlineLyrics = $('#setOnlineLyrics').checked;
    db.settings.recAddToLibrary = $('#setRecAdd').checked;
    db.settings.recordFolder = $('#setRecFolder').value.trim();
    save();
    window.api.rpcConfigure(db.settings.rpcEnabled, db.settings.rpcClientId);
    schedulePreload();
    rpcPush();
  }
  $('#setCancel').addEventListener('click', () => $('#settingsDialog').close('cancel'));
  $('#setRecPick').addEventListener('click', async () => {
    const folder = await window.api.pickFolder();
    if (folder) $('#setRecFolder').value = folder;
  });
  $('#settingsDialog').addEventListener('close', () => {
    if ($('#settingsDialog').returnValue === 'ok') applySettings();
  });

  // ---------- Import and export ----------
  async function exportLibrary() {
    const s = db.settings;
    const r = await window.api.exportLibrary({
      songs: db.songs,
      playlists: db.playlists,
      settings: { volume: s.volume, shuffle: s.shuffle, repeat: s.repeat, gapless: s.gapless, sorts: s.sorts },
    });
    if (r && r.ok) toast(`Exported ${plural(r.count, 'song')} and ${plural(db.playlists.length, 'playlist')}`);
    else if (r && r.error) toast(r.error);
  }

  async function exportPlaylist(p) {
    const songs = p.songIds.map((id) => byId.get(id)).filter(Boolean);
    if (!songs.length) {
      toast('That playlist is empty.');
      return;
    }
    const songCats = {};
    for (const s of songs) if ((p.songCats[s.id] || []).length) songCats[s.path] = p.songCats[s.id];
    const r = await window.api.exportPlaylist({
      name: p.name,
      tracks: songs.map((s) => ({ path: s.path, title: s.title, artist: s.artist, duration: s.duration || 0 })),
      evilfy: {
        name: p.name,
        songs: songs.map((s) => ({ path: s.path, title: s.title, artist: s.artist, album: s.album, duration: s.duration || 0 })),
        categories: p.categories,
        songCats,
        activeCats: p.activeCats,
      },
    });
    if (r && r.ok) toast(`Exported "${p.name}" (${plural(r.count, 'song')})`);
    else if (r && r.error) toast(r.error);
  }

  async function importFromFile(hint, filePath) {
    const d = await window.api.readImport(filePath || null, hint);
    if (!d) return;
    if (d.error) {
      toast(d.error);
      return;
    }
    if (d.kind === 'evilfy-library') await importLibraryData(d);
    else await importPlaylistData(d);
  }

  async function importPlaylistData(d) {
    const have = songByPath();
    const toRead = d.entries.filter((e) => e.exists && !have.has(pathKey(e.path))).map((e) => e.path);
    if (toRead.length) {
      toast('Reading songs...');
      mergeSongs(await window.api.addPaths(toRead));
    }
    const map = songByPath();
    const ids = [];
    const seen = new Set();
    const idByPath = {};
    let missing = 0;
    for (const e of d.entries) {
      const s = map.get(pathKey(e.path));
      if (!s) {
        missing++;
        continue;
      }
      idByPath[pathKey(e.path)] = s.id;
      if (!seen.has(s.id)) {
        seen.add(s.id);
        ids.push(s.id);
      }
    }
    if (!ids.length) {
      toast('None of those songs were found on this computer.');
      return;
    }
    const p = newPlaylistObj(uniquePlaylistName(d.name || 'Imported playlist'));
    p.songIds = ids;
    if (d.kind === 'evilfy-playlist') {
      const catMap = {};
      for (const c of d.categories || []) {
        catMap[c.id] = uid();
        p.categories.push({ id: catMap[c.id], name: c.name });
      }
      for (const [songPath, cats] of Object.entries(d.songCats || {})) {
        const id = idByPath[pathKey(songPath)];
        const mapped = (cats || []).map((c) => catMap[c]).filter(Boolean);
        if (id && mapped.length) p.songCats[id] = mapped;
      }
      p.activeCats = (d.activeCats || []).map((c) => catMap[c]).filter(Boolean);
    }
    db.playlists.push(p);
    save();
    go({ type: 'playlist', id: p.id });
    toast(`Imported "${p.name}": ${plural(ids.length, 'song')}${missing ? `, ${missing} not found` : ''}`);
  }

  async function importLibraryData(d) {
    const choice = await askChoice(
      'Import library',
      `This backup has ${plural(d.songs.length, 'song')} and ${plural(d.playlists.length, 'playlist')}. How do you want to import it?`,
      [
        { label: 'Merge into my library', value: 'merge', primary: true },
        { label: 'Replace my library', value: 'replace' },
        { label: 'Cancel', value: null },
      ]
    );
    if (!choice) return;
    if (choice === 'replace' && !confirm('Replace your whole library, playlists included, with this backup? This cannot be undone.')) return;

    let newSongs = [];
    if (choice === 'replace') {
      queue = [];
      origQueue = null;
      stopAll();
      db.songs = d.songs.map((s) => ({ ...s, id: s.id || uid(), addedAt: s.addedAt || Date.now(), cover: s.cover || '' }));
      db.playlists = d.playlists.map(normalizePlaylist);
      const st = d.settings || {};
      for (const k of ['volume', 'shuffle', 'repeat', 'gapless', 'sorts']) if (st[k] !== undefined) db.settings[k] = st[k];
      applyLoadedSettings();
      newSongs = db.songs.slice();
      reindex();
      resetSelection();
      hist = [{ type: 'library' }];
      hIdx = 0;
      view = hist[0];
    } else {
      const have = songByPath();
      const idMap = {};
      for (const s of d.songs) {
        const existing = have.get(pathKey(s.path));
        if (existing) {
          idMap[s.id] = existing.id;
          continue;
        }
        const ns = { ...s, id: uid(), addedAt: s.addedAt || Date.now(), cover: s.cover || '' };
        idMap[s.id] = ns.id;
        db.songs.push(ns);
        have.set(pathKey(ns.path), ns);
        newSongs.push(ns);
      }
      for (const pl of d.playlists) {
        const songCats = {};
        for (const [oldId, cats] of Object.entries(pl.songCats || {})) if (idMap[oldId]) songCats[idMap[oldId]] = cats;
        db.playlists.push(
          normalizePlaylist({
            ...pl,
            id: uid(),
            name: uniquePlaylistName(pl.name || 'Playlist'),
            songIds: (pl.songIds || []).map((i) => idMap[i]).filter(Boolean),
            songCats,
          })
        );
      }
      reindex();
    }
    save();
    render();
    toast(`Imported ${plural(d.songs.length, 'song')} and ${plural(d.playlists.length, 'playlist')}`);
    await afterImport(newSongs);
  }

  // After an import: restore tags and covers from the files, and offer to find files that moved.
  async function afterImport(newSongs) {
    if (!newSongs.length) return;
    const missing = await window.api.checkFiles(newSongs.map((s) => s.path));
    const gone = new Set(missing);
    const present = newSongs.filter((s) => !gone.has(s.path));
    if (present.length) await refreshMetadata(present, { quiet: true });
    if (missing.length) {
      const yes = await askChoice(
        'Some songs are missing',
        `${plural(missing.length, 'song')} from the backup can't be found on this computer. Choose where your music is now and Evilfy will try to match them.`,
        [
          { label: 'Find them...', value: true, primary: true },
          { label: 'Later', value: false },
        ]
      );
      if (yes) await findMissingFiles(true);
    }
  }

  // Re-matches songs whose files moved: pick the new music folder and songs are matched by folder and file names.
  async function findMissingFiles(skipIntro) {
    const missing = await window.api.checkFiles(db.songs.map((s) => s.path));
    if (!missing.length) {
      toast('No missing files. Everything is where it should be.');
      return;
    }
    if (!skipIntro) {
      const ok = await askChoice(
        'Find missing files',
        `${plural(missing.length, 'song')} can't be found. Choose the folder where your music is now, and Evilfy will match songs by their folder and file names.`,
        [
          { label: 'Choose folder...', value: true, primary: true },
          { label: 'Cancel', value: false },
        ]
      );
      if (!ok) return;
    }
    const folder = await window.api.pickFolder();
    if (!folder) return;
    toast('Searching...');
    const files = await window.api.indexFolder(folder);
    const index = new Map();
    for (const f of files) {
      const segs = f.replace(/\\/g, '/').split('/');
      for (let k = 1; k <= Math.min(4, segs.length); k++) {
        const key = segs.slice(-k).join('/').toLowerCase();
        const arr = index.get(key);
        if (arr) arr.push(f);
        else index.set(key, [f]);
      }
    }
    const gone = new Set(missing);
    let fixed = 0;
    for (const s of db.songs) {
      if (!gone.has(s.path)) continue;
      const segs = s.path.replace(/\\/g, '/').split('/');
      let found = null;
      for (let k = Math.min(4, segs.length); k >= 1 && !found; k--) {
        const arr = index.get(segs.slice(-k).join('/').toLowerCase());
        if (arr && (arr.length === 1 || k > 1)) found = arr[0];
      }
      if (found) {
        s.path = found;
        fixed++;
      }
    }
    save();
    render();
    toast(`Found ${fixed} of ${missing.length} missing songs`);
  }

  // ---------- Audio and control events ----------
  // Both players share these handlers, but only the one that is currently playing is listened to.
  const onAudio = (type, fn) => players.forEach((p) => p.addEventListener(type, (e) => p === audio && fn(e)));

  onAudio('ended', () => {
    if (sleep && sleep.endOfSong) {
      finishSleepAtSongEnd();
      return;
    }
    if (repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    next();
  });
  onAudio('error', () => {
    if (qIndex < 0) return;
    const s = byId.get(queue[qIndex]);
    toast(`Can't play "${s ? s.title : 'this song'}". Is the file still there?`);
    errStreak++;
    if (errStreak >= Math.max(queue.length, 1)) {
      errStreak = 0;
      return stopAll();
    }
    next();
  });
  onAudio('playing', () => {
    errStreak = 0;
    rpcPush();
  });
  onAudio('play', syncTransport);
  onAudio('pause', () => {
    syncTransport();
    rpcPush();
  });
  onAudio('loadedmetadata', () => {
    $('#tot').textContent = fmt(audio.duration);
    const s = curSong();
    if (s && !s.duration && isFinite(audio.duration)) {
      s.duration = audio.duration;
      save();
    }
    rpcPush();
  });
  onAudio('timeupdate', () => {
    if (!isFinite(audio.duration)) return;
    if (!dragging) {
      seeks.forEach((r) => {
        r.value = (audio.currentTime / audio.duration) * 1000;
        setFill(r);
      });
      $('#cur').textContent = fmt(audio.currentTime);
    }
    updateLyricHighlight(false);
    karaokeTimeupdate();
  });
  onAudio('seeked', () => {
    updateLyricHighlight(false);
    rpcPush();
  });

  for (const r of seeks) {
    r.addEventListener('pointerdown', () => (dragging = true));
    r.addEventListener('pointerup', () => (dragging = false));
    r.addEventListener('input', () => {
      seeks.forEach((o) => {
        o.value = r.value;
        setFill(o);
      });
      if (isFinite(audio.duration)) {
        audio.currentTime = (r.value / 1000) * audio.duration;
        $('#cur').textContent = fmt(audio.currentTime);
      }
    });
  }
  vol.addEventListener('input', () => {
    players.forEach((p) => (p.volume = vol.value / 100));
    db.settings.volume = audio.volume;
    setFill(vol);
    save();
  });

  for (const id of ['#btnPlay', '#btnMiniPlay']) $(id).addEventListener('click', togglePlay);
  for (const id of ['#btnNext', '#btnMiniNext']) $(id).addEventListener('click', next);
  for (const id of ['#btnPrev', '#btnMiniPrev']) $(id).addEventListener('click', prev);
  for (const id of ['#btnShuffle', '#btnMiniShuffle']) $(id).addEventListener('click', () => setShuffle(!shuffle));
  for (const id of ['#btnRepeat', '#btnMiniRepeat']) $(id).addEventListener('click', cycleRepeat);
  $('#btnBack').addEventListener('click', () => step(-1));
  $('#btnFwd').addEventListener('click', () => step(1));
  $('#btnQueue').addEventListener('click', () => setPanel('queue'));
  $('#btnLyrics').addEventListener('click', () => setPanel('lyrics'));
  $('#btnSleep').addEventListener('click', openSleepMenu);
  $('#btnMini').addEventListener('click', () => setMini(true));
  $('#btnExpand').addEventListener('click', () => setMini(false));

  search.addEventListener('input', () => {
    searchTerm = search.value.trim().toLowerCase();
    if (view.type !== 'library') go({ type: 'library' });
    else renderMain();
  });

  // ---------- Right-click menu ----------
  function menuHtml(items) {
    return items
      .map((it) => {
        if (it.sep) return '<div class="sep" role="separator"></div>';
        const idx = ctxActions.push(it.run || null) - 1;
        const cls = ['mi', it.disabled ? 'dis' : '', it.danger ? 'danger' : '', it.items ? 'has-sub' : ''].filter(Boolean).join(' ');
        const chk = it.checked === undefined ? '' : `<span class="chk">${it.checked === true ? '✓' : it.checked === 'mixed' ? '–' : ''}</span>`;
        const sub = it.items ? `<span class="arrow">›</span><div class="submenu" role="menu">${menuHtml(it.items)}</div>` : '';
        return `<div class="${cls}" role="menuitem" tabindex="-1" data-ci="${idx}" ${it.disabled ? 'aria-disabled="true"' : ''}>${chk}<span class="lbl">${esc(it.label)}</span>${sub}</div>`;
      })
      .join('');
  }

  function openMenu(items, x, y) {
    ctxActions = [];
    ctx.innerHTML = menuHtml(items);
    ctx.hidden = false;
    ctx.style.left = '0px';
    ctx.style.top = '0px';
    const r = ctx.getBoundingClientRect();
    ctx.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    ctx.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    const first = ctx.querySelector(':scope > .mi:not(.dis)');
    if (first) first.focus();
  }

  function closeMenu() {
    if (ctx.hidden) return;
    ctx.hidden = true;
    ctx.innerHTML = '';
    ctxActions = [];
  }

  ctx.addEventListener('click', (e) => {
    const mi = e.target.closest('.mi');
    if (!mi || mi.classList.contains('dis')) return;
    if (mi.classList.contains('has-sub')) {
      mi.classList.toggle('open');
      return;
    }
    const run = ctxActions[Number(mi.dataset.ci)];
    closeMenu();
    if (run) run();
  });

  // Keep submenus on screen: flip left or shift up when they would run off the window.
  ctx.addEventListener('mouseover', (e) => {
    const mi = e.target.closest('.mi.has-sub');
    if (!mi) return;
    const sub = mi.querySelector(':scope > .submenu');
    if (!sub) return;
    mi.classList.remove('flip');
    sub.style.top = '';
    let sr = sub.getBoundingClientRect();
    if (sr.right > window.innerWidth - 4) {
      mi.classList.add('flip');
      sr = sub.getBoundingClientRect();
    }
    if (sr.bottom > window.innerHeight - 4) sub.style.top = -5 - (sr.bottom - window.innerHeight + 8) + 'px';
  });

  ctx.addEventListener('keydown', (e) => {
    const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.mi') : null;
    const level = cur ? cur.parentElement : ctx;
    const items = [...level.children].filter((c) => c.classList.contains('mi') && !c.classList.contains('dis'));
    const at = cur ? items.indexOf(cur) : -1;
    let handled = true;
    if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
    else if (e.key === 'ArrowRight') {
      if (cur && cur.classList.contains('has-sub')) {
        cur.classList.add('open');
        cur.querySelector(':scope > .submenu > .mi:not(.dis)')?.focus();
      }
    } else if (e.key === 'ArrowLeft') {
      const parent = level.closest('.has-sub');
      if (parent && level !== ctx) {
        parent.classList.remove('open');
        parent.focus();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (cur) cur.click();
    } else if (e.key === 'Escape') closeMenu();
    else if (e.key === 'Tab') closeMenu();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!ctx.hidden && !ctx.contains(e.target)) closeMenu();
    },
    true
  );
  // Close menus when you switch to another program, but ignore a stray blur while the window still has focus.
  window.addEventListener('blur', () => setTimeout(() => !document.hasFocus() && closeMenu(), 60));
  window.addEventListener('resize', closeMenu);
  $('#main').addEventListener('scroll', closeMenu);

  const playlistSubmenu = (ids) => {
    const items = db.playlists.map((p) => {
      const all = ids.every((id) => p.songIds.includes(id));
      return { label: p.name, checked: all, disabled: all, run: () => addToPlaylist(ids, p.id) };
    });
    if (items.length) items.push({ sep: true });
    items.push({ label: 'New playlist...', run: () => newPlaylistWith(ids) });
    return items;
  };

  const categorySubmenu = (p, ids) => {
    const items = p.categories.map((c) => {
      const have = ids.filter((id) => (p.songCats[id] || []).includes(c.id)).length;
      const state = have === ids.length ? true : have ? 'mixed' : false;
      return { label: c.name, checked: state, run: () => setCategory(p, ids, c.id, state !== true) };
    });
    if (items.length) items.push({ sep: true });
    items.push({ label: 'New category...', checked: false, run: () => newCategoryWith(p, ids) });
    return items;
  };

  function songMenu(ids) {
    const n = ids.length;
    const one = n === 1;
    const s = one ? byId.get(ids[0]) : null;
    const p = curPlaylist();
    const items = [
      { label: one ? 'Play' : `Play ${n} songs`, run: () => (one ? playInContext(ids[0]) : playQueue(ids, 0)) },
      { label: 'Play next', run: () => enqueue(ids, true) },
      { label: 'Add to queue', run: () => enqueue(ids, false) },
      { sep: true },
      { label: 'Add to playlist', items: playlistSubmenu(ids) },
    ];
    if (p && ids.every((id) => p.songIds.includes(id))) items.push({ label: 'Categories', items: categorySubmenu(p, ids) });
    items.push({ sep: true });
    if (one) {
      if (!(view.type === 'album' && view.key === albumKey(s))) items.push({ label: 'Go to album', run: () => go({ type: 'album', key: albumKey(s) }) });
      items.push({ label: 'Share file', run: () => window.api.showInFolder(s.path) });
      items.push({ label: 'Song info', run: () => showInfo(s) });
    }
    if (one && hasTimedLyrics(s)) items.push({ label: 'Sing karaoke', run: () => singSong(ids[0]) });
    items.push({ label: 'Get lyrics online', run: () => getLyricsFor(ids) });
    items.push({ label: 'Edit info...', run: () => openEditor(ids) });
    items.push({ sep: true });
    if (p) items.push({ label: 'Remove from playlist', run: () => removeFromPlaylist(p, ids) });
    items.push({ label: 'Remove from library', danger: true, run: () => removeSongsFromLibrary(ids) });
    return items;
  }

  function queueMenu(i) {
    const s = byId.get(queue[i]);
    if (!s) return null;
    return [
      {
        label: 'Play',
        run: () => {
          qIndex = i;
          loadCurrent();
        },
      },
      { label: 'Remove from queue', run: () => removeFromQueue(i) },
      { sep: true },
      { label: 'Add to playlist', items: playlistSubmenu([s.id]) },
      { label: 'Go to album', run: () => go({ type: 'album', key: albumKey(s) }) },
      { label: 'Share file', run: () => window.api.showInFolder(s.path) },
      { label: 'Song info', run: () => showInfo(s) },
      { label: 'Get lyrics online', run: () => getLyricsFor([s.id]) },
      { label: 'Edit info...', run: () => openEditor([s.id]) },
    ];
  }

  function albumMenu(key) {
    const a = findAlbum(key);
    if (!a) return null;
    const ids = albumSongs(a).map((s) => s.id);
    return [
      { label: 'Play album', run: () => playQueue(ids, 0) },
      { label: 'Play next', run: () => enqueue(ids, true) },
      { label: 'Add to queue', run: () => enqueue(ids, false) },
      { sep: true },
      { label: 'Add to playlist', items: playlistSubmenu(ids) },
      { sep: true },
      { label: 'Open album', run: () => go({ type: 'album', key }) },
    ];
  }

  function playlistMenu(pid) {
    const p = db.playlists.find((x) => x.id === pid);
    if (!p) return null;
    return [
      {
        label: 'Play',
        run: () => {
          const set = playSet(p);
          if (set.length) playQueue(set, 0);
          else toast('Nothing to play yet.');
        },
      },
      { label: 'Open', run: () => go({ type: 'playlist', id: p.id }) },
      { sep: true },
      { label: 'Rename', run: () => renamePlaylist(p) },
      { label: 'Export playlist...', run: () => exportPlaylist(p) },
      { label: 'Delete', danger: true, run: () => deletePlaylist(p) },
    ];
  }

  function openImportExportMenu(btn) {
    const r = btn.getBoundingClientRect();
    openMenu(
      [
        { label: 'Export library...', run: exportLibrary },
        { label: 'Import library...', run: () => importFromFile('library') },
        { label: 'Import playlist...', run: () => importFromFile('playlist') },
        { sep: true },
        { label: 'Find missing files...', run: () => findMissingFiles(false) },
      ],
      r.left,
      r.bottom + 2
    );
  }

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (ctx.contains(e.target)) return;
    const row = e.target.closest('.list .row');
    const qrow = e.target.closest('.qrow');
    const card = e.target.closest('.card[data-key]');
    const pl = e.target.closest('.pl[data-id]');
    let items = null;
    if (row) {
      if (!selected.has(row.dataset.id)) {
        selected = new Set([row.dataset.id]);
        lastSel = row.dataset.id;
        applySelection();
      }
      items = songMenu(orderedSelected());
    } else if (qrow) items = queueMenu(Number(qrow.dataset.i));
    else if (card) items = albumMenu(card.dataset.key);
    else if (pl) items = playlistMenu(pl.dataset.id);
    if (items) openMenu(items, e.clientX, e.clientY);
  });

  // ---------- Drag and drop ----------
  const clearDropMarks = () => $$('.drop, .drop-before, .drop-after').forEach((el) => el.classList.remove('drop', 'drop-before', 'drop-after'));
  const lowerHalf = (e, el) => {
    const r = el.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const allow = (e, effect) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = effect;
  };
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const showDropHint = (on) => ($('#dropHint').hidden = !on);

  document.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const row = t.closest('.list .row');
    const qrow = t.closest('.qrow');
    if (row) {
      const id = row.dataset.id;
      if (!selected.has(id)) {
        selected = new Set([id]);
        lastSel = id;
        applySelection();
      }
      drag = { from: view.type, ids: orderedSelected() };
    } else if (qrow) {
      const qi = Number(qrow.dataset.i);
      drag = { from: 'queue', qi, ids: [queue[qi]] };
    } else return;
    e.dataTransfer.setData('application/x-evilfy-songs', JSON.stringify(drag.ids));
    e.dataTransfer.effectAllowed = 'copyMove';
  });

  document.addEventListener('dragend', () => {
    drag = null;
    clearDropMarks();
    showDropHint(false);
  });

  document.addEventListener('dragover', (e) => {
    if (drag) {
      clearDropMarks();
      const p = curPlaylist();
      const pl = e.target.closest('.pl[data-id]');
      const chip = e.target.closest('.chip');
      const row = e.target.closest('.list .row');
      const qrow = e.target.closest('.qrow');
      if (pl) {
        pl.classList.add('drop');
        allow(e, 'copy');
      } else if (chip && p && drag.from !== 'queue') {
        chip.classList.add('drop');
        allow(e, 'copy');
      } else if (row && p && isCustomOrder(p) && drag.from === 'playlist' && !drag.ids.includes(row.dataset.id)) {
        row.classList.add(lowerHalf(e, row) ? 'drop-after' : 'drop-before');
        allow(e, 'move');
      } else if (qrow && drag.from === 'queue' && Number(qrow.dataset.i) !== drag.qi) {
        qrow.classList.add(lowerHalf(e, qrow) ? 'drop-after' : 'drop-before');
        allow(e, 'move');
      }
      return;
    }
    if (hasFiles(e)) {
      e.preventDefault();
      showDropHint(true);
    }
  });

  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) showDropHint(false);
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearDropMarks();
    showDropHint(false);

    if (drag) {
      const d = drag;
      drag = null;
      const p = curPlaylist();
      const pl = e.target.closest('.pl[data-id]');
      const chip = e.target.closest('.chip');
      const row = e.target.closest('.list .row');
      const qrow = e.target.closest('.qrow');
      if (pl) {
        addToPlaylist(d.ids, pl.dataset.id);
      } else if (chip && p && d.from !== 'queue') {
        const catId = chip.querySelector('.cat').dataset.cat;
        const c = p.categories.find((x) => x.id === catId);
        const missing = d.ids.filter((id) => !p.songIds.includes(id));
        if (missing.length) p.songIds.push(...missing);
        setCategory(p, d.ids, catId, true);
        toast(`Filed ${plural(d.ids.length, 'song')} under "${c ? c.name : 'category'}"${missing.length ? ' and added them to the playlist' : ''}`);
      } else if (row && p && isCustomOrder(p) && d.from === 'playlist') {
        reorderPlaylist(p, d.ids, row.dataset.id, lowerHalf(e, row));
        save();
        render();
      } else if (qrow && d.from === 'queue') {
        moveInQueue(d.qi, Number(qrow.dataset.i) + (lowerHalf(e, qrow) ? 1 : 0));
      }
      return;
    }

    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;
    const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean);
    const lists = paths.filter((p) => /\.(m3u8?|json)$/i.test(p));
    const rest = paths.filter((p) => !lists.includes(p));
    for (const lp of lists) await importFromFile('playlist', lp);
    if (!rest.length) return;
    toast('Reading songs...');
    const found = await window.api.addPaths(rest);
    if (!found.length && !lists.length) toast('No songs found in what you dropped.');
    else addSongs(found);
  });

  // ---------- Clicks and keys ----------
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyM') {
      e.preventDefault();
      setMini(!mini);
      return;
    }
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag);
    if (!ctx.hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA' && !typing && !mini) {
      e.preventDefault();
      selected = new Set(rowIds());
      applySelection();
      return;
    }
    if (e.code === 'Escape' && !typing) {
      closeSidebar();
      clearSelection();
      return;
    }
    if (e.code !== 'Space') return;
    if (typing || tag === 'BUTTON') return;
    e.preventDefault();
    togglePlay();
  });

  document.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.list .row');
    if (!row || e.target.closest('[data-action]')) return;
    if (view.type === 'karaoke') singSong(row.dataset.id);
    else playInContext(row.dataset.id);
  });

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    const row = e.target.closest('.list .row');
    if (row && !el) {
      selectRow(row, e);
      return;
    }
    if (!el) {
      if (e.target.closest('#main') && !e.target.closest('.list')) clearSelection();
      return;
    }
    const { action, id, cat, tab, key, scope } = el.dataset;
    const p = curPlaylist();
    if (el.closest('#sidebar') && action !== 'new-playlist') closeSidebar();

    switch (action) {
      case 'open-library':
        go({ type: 'library' });
        break;

      case 'open-karaoke':
        go({ type: 'karaoke' });
        break;

      case 'sing-row':
        singSong(id);
        break;

      case 'k-back':
        karaokeStage = false;
        render();
        break;

      case 'k-open-stage':
        if (curSong()) {
          karaokeStage = true;
          render();
        }
        break;

      case 'k-full':
        toggleFullscreen();
        break;

      case 'k-controls':
        db.settings.karaoke.controls = !controlsOpen();
        save();
        applyControlsState();
        break;

      case 'k-showall': {
        const k = db.settings.karaoke;
        k.showAll = !k.showAll;
        save();
        render();
        break;
      }

      case 'k-rescan':
        kScanned = false;
        toast('Looking for .lrc files...');
        await scanLrc();
        render();
        break;

      case 'k-get-lyrics': {
        const picked = orderedSelected();
        const ids = picked.length ? picked : db.songs.filter(matches).filter((x) => !hasTimedLyrics(x)).map((x) => x.id);
        await getLyricsFor(ids);
        break;
      }

      case 'k-get-lyrics-one':
        if (curSong()) await getLyricsFor([curSong().id]);
        break;

      case 'k-cancel-lyrics':
        if (lyricsJob) lyricsJob.cancel = true;
        break;

      case 'k-edit':
        if (curSong()) openEditor([curSong().id]);
        break;

      case 'k-remover': {
        const k = db.settings.karaoke;
        k.remover = !k.remover;
        save();
        refreshStage();
        applyKaraokeAudio();
        break;
      }

      case 'k-key': {
        const s = curSong();
        if (!s) break;
        const d = Number(el.dataset.d);
        s.keyShift = d === 0 ? 0 : Math.max(-6, Math.min(6, (s.keyShift || 0) + d));
        save();
        refreshStage();
        applyKaraokeAudio();
        break;
      }

      case 'k-timing': {
        const s = curSong();
        if (!s) break;
        s.lyricsOffset = Math.max(-5000, Math.min(5000, (s.lyricsOffset || 0) + Number(el.dataset.d)));
        save();
        kIdx = -2;
        refreshStage();
        break;
      }

      case 'k-mic-on':
        await enableMic();
        break;

      case 'k-mic-off':
        if (recorder.active) await stopRecording();
        disableMic();
        break;

      case 'k-rec':
        if (recorder.active) await stopRecording();
        else await startRecording();
        break;

      case 'k-sync-auto':
        db.settings.mic.syncMs = null;
        save();
        if (graph && graph.rec) graph.rec.delay.delayTime.value = recSyncSeconds();
        renderMicGroup();
        break;

      case 'k-show-rec':
        if (lastRecording) window.api.showInFolder(lastRecording.path);
        break;

      case 'open-settings':
        openSettings();
        break;

      case 'open-playlist':
        go({ type: 'playlist', id });
        break;

      case 'open-album':
        go({ type: 'album', key });
        break;

      case 'tab':
        libTab = tab;
        render();
        break;

      case 'sort':
        setSort(scope, key);
        break;

      case 'sort-menu':
        openSortMenu(scope, el);
        break;

      case 'io-menu':
        openImportExportMenu(el);
        break;

      case 'new-playlist': {
        const name = await askText('New playlist');
        if (!name) break;
        const np = newPlaylistObj(name);
        db.playlists.push(np);
        save();
        go({ type: 'playlist', id: np.id });
        break;
      }

      case 'rename-playlist':
        if (p) await renamePlaylist(p);
        break;

      case 'export-playlist':
        if (p) await exportPlaylist(p);
        break;

      case 'delete-playlist':
        if (p) deletePlaylist(p);
        break;

      case 'add-files':
        addSongs(await window.api.addFiles());
        break;

      case 'add-folder':
        addSongs(await window.api.addFolder());
        break;

      case 'refresh':
        await refreshMetadata();
        break;

      case 'play-row':
        playInContext(id);
        break;

      case 'play-album': {
        const a = curAlbum();
        if (a) playQueue(albumSongs(a).map((s) => s.id), 0);
        break;
      }

      case 'play-set': {
        if (!p) break;
        const set = playSet(p);
        if (!set.length) {
          toast('No songs in the selected categories yet.');
          break;
        }
        playQueue(set, 0);
        break;
      }

      case 'new-cat':
        if (p) await newCategoryWith(p, []);
        break;

      case 'delete-cat': {
        if (!p) break;
        const c = p.categories.find((x) => x.id === cat);
        if (!c || !confirm(`Delete the category "${c.name}"? The songs stay in the playlist.`)) break;
        p.categories = p.categories.filter((x) => x.id !== cat);
        p.activeCats = p.activeCats.filter((x) => x !== cat);
        for (const sid of Object.keys(p.songCats)) p.songCats[sid] = p.songCats[sid].filter((x) => x !== cat);
        save();
        render();
        break;
      }

      case 'toggle-active':
        if (!p) break;
        p.activeCats = p.activeCats.includes(cat) ? p.activeCats.filter((x) => x !== cat) : [...p.activeCats, cat];
        save();
        render();
        break;
    }
  });

  // The queue rows are buttons without data-action, so handle them here.
  $('#queuePanel').addEventListener('click', (e) => {
    const q = e.target.closest('.qrow');
    if (!q) return;
    qIndex = Number(q.dataset.i);
    loadCurrent();
  });

  // ---------- Karaoke ----------
  const hasTimedLyrics = (s) => !!(s.hasLrc || (s.lyrics && /\[\d{1,3}:\d{2}/.test(s.lyrics)));
  const lyricsStatus = (s) => (hasTimedLyrics(s) ? 'Timed lyrics' : s.lyrics ? 'Plain lyrics only' : 'No lyrics');
  const lyricOffset = () => {
    const s = curSong();
    return (s && s.lyricsOffset) || 0;
  };
  const karaokeOn = () => view.type === 'karaoke' && karaokeStage;
  const keyLabel = (n) => (n > 0 ? '+' + n : String(n));

  function karaokeHtml() {
    if (karaokeStage) return stageHtml();
    const k = db.settings.karaoke;
    const ready = db.songs.filter(hasTimedLyrics).length;
    const list = libList().filter((s) => k.showAll || hasTimedLyrics(s));
    const job = lyricsJob ? lyricsProgressHtml() : '';
    const head = `<header class="head">
        <div class="info">
          <h1>Karaoke</h1><div class="sub">${plural(ready, 'song')} ready to sing</div>
          <div class="actions">
            ${curSong() ? '<button class="btn primary" data-action="k-open-stage">Open stage</button>' : ''}
            <button class="btn ${curSong() ? '' : 'primary'}" data-action="k-get-lyrics">Get synced lyrics</button>
            <button class="btn ${k.showAll ? 'on' : ''}" data-action="k-showall" aria-pressed="${k.showAll}">Show songs without timed lyrics</button>
            <button class="btn" data-action="k-rescan">Rescan</button>
            ${sortButton('library')}
          </div>
          <div id="kProgress">${job}</div>
        </div>
      </header>`;
    if (!db.songs.length) return head + '<div class="empty"><p>Your library is empty.</p><p>Add some songs first, then come back to sing along.</p></div>';
    if (!list.length) {
      return (
        head +
        `<div class="empty"><p>${searchTerm ? `No karaoke songs match "${esc(searchTerm)}".` : 'No songs are ready to sing yet.'}</p>
        <p>Karaoke needs timed lyrics. Click <b>Get synced lyrics</b> to download them, put a .lrc file with the same name next to a song, or paste LRC lyrics in Edit info.</p></div>`
      );
    }
    return (
      head +
      listHead('library', null, 'Lyrics') +
      `<div class="list">${list.map((s) => libRow(s, lyricsStatus(s), 'sing-row', lyricsStatus(s))).join('')}</div>`
    );
  }

  function lyricsProgressHtml() {
    const j = lyricsJob;
    return `<div class="k-progress"><span>Getting lyrics: ${j.done} of ${j.total}${j.last ? ` (${esc(j.last)})` : ''}. Timed: ${j.synced}, plain only: ${j.plain}, not found: ${j.none}.</span>
      <button class="btn small" data-action="k-cancel-lyrics">Cancel</button></div>`;
  }
  function updateLyricsProgress() {
    const el = $('#kProgress');
    if (el) el.innerHTML = lyricsJob ? lyricsProgressHtml() : '';
  }

  // Start singing a song: the stage opens and the song plays with its neighbours from the list queued after it.
  function singSong(id) {
    const s = byId.get(id);
    if (!s) return;
    if (view.type !== 'karaoke') go({ type: 'karaoke' });
    const k = db.settings.karaoke;
    const ids = libList().filter((x) => k.showAll || hasTimedLyrics(x)).map((x) => x.id);
    const i = ids.indexOf(id);
    karaokeStage = true;
    playQueue(i >= 0 ? ids : [id], i >= 0 ? i : 0);
    render();
  }

  // Checks which songs have a .lrc file next to them (fast: it only looks for the files).
  async function scanLrc() {
    kScanned = true;
    const have = new Set(await window.api.scanLrc(db.songs.map((s) => s.path)));
    let changed = false;
    for (const s of db.songs) {
      const v = have.has(s.path);
      if (!!s.hasLrc !== v) {
        s.hasLrc = v;
        changed = true;
      }
    }
    if (changed) {
      save();
      if (view.type === 'karaoke' && !karaokeStage) renderMain();
    }
  }

  function afterMainRender() {
    const on = karaokeOn();
    $('#app').classList.toggle('k-full', on && !!document.fullscreenElement);
    applyKaraokeAudio();
    if (view.type === 'karaoke' && !kScanned) scanLrc();
    if (on) {
      kIdx = -2;
      kSig = '';
      renderMicGroup();
      refreshStage();
      startStageLoop();
    } else {
      stopStageLoop();
      if (recorder.active) stopRecording();
      if (micState.stream) disableMic();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  }

  function onSongStart(s) {
    if (recorder.active && recorder.songId !== s.id) stopRecording();
    if (karaokeOn()) {
      applyKaraokeAudio();
      kIdx = -2;
      kSig = '';
      refreshStage();
    }
  }

  // The queue ended or playback was stopped: the stage closes and the song list comes back.
  function onPlaybackStopped() {
    if (recorder.active) stopRecording();
    if (karaokeStage) {
      karaokeStage = false;
      if (view.type === 'karaoke') render();
    }
  }

  function karaokeTimeupdate() {
    if (recorder.active) {
      if (repeat === 'one' && audio.currentTime < recorder.lastT - 1.5) stopRecording(); // the song looped
      recorder.lastT = audio.currentTime;
    }
  }

  // ----- The stage -----
  function stageHtml() {
    const k = db.settings.karaoke;
    const tempos = [0.75, 0.85, 1, 1.1, 1.25].map((t) => `<option value="${t}" ${t === k.tempo ? 'selected' : ''}>${t}x</option>`).join('');
    return `<div class="stage" id="kStage">
      <div class="k-bg" id="kBg"></div>
      <div class="k-top">
        <button class="btn small" data-action="k-back">Back to songs</button>
        <div class="k-title"><div id="kSong">Nothing playing</div><span id="kArtist"></span></div>
        <button class="btn small toggle" id="kCtlBtn" data-action="k-controls" aria-pressed="true">Controls</button>
        <button class="btn small" id="kFull" data-action="k-full">Full screen</button>
      </div>
      <div class="k-lyrics" id="kLyrics"></div>
      <div class="k-dots" id="kDots"><i></i><i></i><i></i></div>
      <div class="k-controls">
        <div class="k-group">
          <button class="btn small toggle" id="kRemover" data-action="k-remover" aria-pressed="${k.remover}">Voice remover</button>
          <input type="range" id="kStrength" min="0" max="100" value="${k.strength}" aria-label="Voice remover strength">
          <span class="k-val" id="kStrengthVal">${k.strength}%</span>
          <span class="k-warn" id="kMono"></span>
        </div>
        <div class="k-group">
          <span class="lbl">Key</span>
          <button class="btn small" data-action="k-key" data-d="-1" aria-label="Lower the key by one semitone">-</button>
          <span class="k-val" id="kKeyVal">0</span>
          <button class="btn small" data-action="k-key" data-d="1" aria-label="Raise the key by one semitone">+</button>
          <button class="btn small" data-action="k-key" data-d="0">Reset</button>
        </div>
        <div class="k-group">
          <span class="lbl">Tempo</span>
          <select id="kTempo" aria-label="Tempo">${tempos}</select>
        </div>
        <div class="k-group">
          <span class="lbl">Lyrics timing</span>
          <button class="btn small" data-action="k-timing" data-d="-100" aria-label="Show the lyrics 0.1 seconds earlier">-0.1s</button>
          <span class="k-val" id="kOffsetVal">0.0s</span>
          <button class="btn small" data-action="k-timing" data-d="100" aria-label="Show the lyrics 0.1 seconds later">+0.1s</button>
        </div>
        <div class="k-group k-mic" id="kMic"></div>
      </div>
    </div>`;
  }

  // The controls panel: open by default in a tall window, hidden by default in a short one or full screen.
  function controlsOpen() {
    const c = db.settings.karaoke.controls;
    return c === null || c === undefined ? window.innerHeight >= 760 && !document.fullscreenElement : !!c;
  }
  function applyControlsState() {
    const st = $('#kStage');
    if (!st) return;
    const open = controlsOpen();
    st.classList.toggle('ctl-open', open);
    const b = $('#kCtlBtn');
    if (b) b.setAttribute('aria-pressed', String(open));
    fitCurrent();
  }

  function refreshStage() {
    if (!$('#kStage')) return;
    applyControlsState();
    const s = curSong();
    const k = db.settings.karaoke;
    $('#kSong').textContent = s ? s.title : 'Nothing playing';
    $('#kArtist').textContent = s ? s.artist : '';
    $('#kBg').style.backgroundImage = s && s.cover ? `url("${fileUrl(s.cover).replace(/"/g, '%22')}")` : 'none';
    $('#kRemover').setAttribute('aria-pressed', String(k.remover));
    $('#kStrength').value = k.strength;
    $('#kStrengthVal').textContent = k.strength + '%';
    $('#kKeyVal').textContent = keyLabel((s && s.keyShift) || 0);
    $('#kOffsetVal').textContent = (lyricOffset() / 1000).toFixed(1) + 's';
    $('#kTempo').value = String(k.tempo);
  }

  function buildStageLyrics() {
    const box = $('#kLyrics');
    if (!box) return;
    const s = curSong();
    const getBtn = '<button class="btn primary" data-action="k-get-lyrics-one">Get synced lyrics</button> <button class="btn" data-action="k-edit">Paste lyrics</button>';
    if (!s) box.innerHTML = '<div class="k-msg">Pick a song to sing.</div>';
    else if (!lyr || lyr.id !== s.id || lyr.data === undefined) box.innerHTML = '<div class="k-msg">Loading lyrics...</div>';
    else if (lyr.data === null) box.innerHTML = `<div class="k-msg"><p>This song has no lyrics yet.</p><div>${getBtn}</div></div>`;
    else if (lyr.data.kind === 'plain') {
      box.innerHTML = `<div class="k-msg"><p>These lyrics have no timing, so they can't follow the music.</p><div>${getBtn}</div></div><pre class="k-plain">${esc(lyr.data.text)}</pre>`;
    } else box.innerHTML = '';
  }

  function renderStageLines(n) {
    const L = lyr.data.lines;
    const box = $('#kLyrics');
    const row = (i, cls) => {
      const l = L[i];
      if (!l) return `<div class="k-line ${cls}"></div>`;
      return `<div class="k-line ${cls}"><span class="k-text">${l.text ? esc(l.text) : ''}</span></div>`;
    };
    box.innerHTML = row(n - 1, 'k-prev') + row(n, 'k-cur') + row(n + 1, 'k-next') + row(n + 2, 'k-next2');
    fitCurrent();
  }

  // Shrink a long line to fit on one row; if it still doesn't fit, let it wrap (no sweep then).
  function fitCurrent() {
    const box = $('#kLyrics');
    const line = box && box.querySelector('.k-cur');
    const text = line && line.querySelector('.k-text');
    if (!text) return;
    line.classList.remove('wrap');
    text.style.fontSize = '';
    const avail = box.clientWidth - 8;
    const w = text.getBoundingClientRect().width;
    if (w > avail && w > 0) {
      const r = avail / w;
      if (r >= 0.55) text.style.fontSize = (r * 100).toFixed(1) + '%';
      else line.classList.add('wrap');
    }
  }

  function startStageLoop() {
    if (stageRaf) return;
    const tick = () => {
      stageRaf = requestAnimationFrame(tick);
      stageFrame();
    };
    stageRaf = requestAnimationFrame(tick);
  }
  function stopStageLoop() {
    if (stageRaf) cancelAnimationFrame(stageRaf);
    stageRaf = 0;
  }

  function stageFrame() {
    if (!$('#kStage')) return;
    const s = curSong();
    const sig = !s ? 'none' : !lyr || lyr.id !== s.id || lyr.data === undefined ? 'loading' : lyr.data === null ? 'empty' : lyr.data.kind + ':' + (lyr.data.lines ? lyr.data.lines.length : lyr.data.text.length);
    if (sig !== kSig) {
      kSig = sig;
      kIdx = -2;
      buildStageLyrics();
    }
    updateMeter();
    const now = performance.now();
    if (now - kMonoAt > 600) {
      kMonoAt = now;
      monoCheck();
    }
    if (!lyr || !lyr.data || lyr.data.kind !== 'lrc') return;
    const L = lyr.data.lines;
    const tMs = audio.currentTime * 1000 - lyricOffset();
    const n = currentLine();
    if (n !== kIdx) {
      kIdx = n;
      renderStageLines(n);
    }
    const cur = $('#kLyrics .k-cur .k-text');
    if (cur && n >= 0) {
      const startT = L[n].t;
      const endT = n + 1 < L.length ? L[n + 1].t : startT + 4000;
      const dur = Math.max(600, Math.min(endT - startT - 80, 9000));
      cur.style.setProperty('--fill', (Math.max(0, Math.min(1, (tMs - startT) / dur)) * 100).toFixed(1) + '%');
    }
    updateDots(n, tMs, L);
  }

  // The 3-2-1 dots before a line that starts after a gap.
  function updateDots(n, tMs, L) {
    const dots = $('#kDots');
    if (!dots) return;
    const nextT = L[n + 1] ? L[n + 1].t : n < 0 && L[0] ? L[0].t : null;
    const gap = n < 0 || !L[n].text || (L[n + 1] && L[n + 1].t - L[n].t > 9000);
    let lit = 0;
    let show = false;
    if (gap && nextT !== null) {
      const left = (nextT - tMs) / 1000;
      if (left > 0 && left <= 3.5) {
        show = true;
        lit = Math.max(1, Math.min(3, Math.ceil(left)));
      }
    }
    const sig = show ? lit : 0;
    if (sig === kDotsSig) return;
    kDotsSig = sig;
    dots.classList.toggle('show', show);
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i < lit));
  }

  function setMonoWarn(text) {
    const el = $('#kMono');
    if (el && el.textContent !== text) el.textContent = text;
  }

  // If almost nothing is left after cancelling the center, the song is probably mono.
  function monoCheck() {
    if (!graph || !db.settings.karaoke.remover || audio.paused) return setMonoWarn('');
    const rms = (an) => {
      const a = graph.buf || (graph.buf = new Float32Array(1024));
      an.getFloatTimeDomainData(a);
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
      return Math.sqrt(sum / a.length);
    };
    const rin = rms(graph.anIn);
    const rside = rms(graph.anSide);
    setMonoWarn(rin > 0.01 && rside / rin < 0.06 ? "This song looks mono, so the voice remover can't separate the voice." : '');
  }

  // Loads one of the audio worklet files (see the note in main.js about why this goes through a data: URL).
  async function loadWorklet(ctx, name) {
    const source = await window.api.workletSource(name);
    if (!source) throw new Error('missing worklet ' + name);
    let bin = '';
    new TextEncoder().encode(source).forEach((b) => (bin += String.fromCharCode(b)));
    await ctx.audioWorklet.addModule('data:text/javascript;base64,' + btoa(bin));
  }

  // ----- Audio effects: voice remover, key change, tempo -----
  function karaokeEffects() {
    if (!karaokeOn()) return { remover: 0, semitones: 0, tempo: 1 };
    const k = db.settings.karaoke;
    const s = curSong();
    return { remover: k.remover ? k.strength / 100 : 0, semitones: (s && s.keyShift) || 0, tempo: k.tempo || 1 };
  }

  async function applyKaraokeAudio() {
    const fx = karaokeEffects();
    players.forEach((p) => {
      p.defaultPlaybackRate = fx.tempo; // loading a new song resets the speed to this
      p.playbackRate = fx.tempo;
      p.preservesPitch = true;
    });
    if (!graph && fx.remover === 0 && fx.semitones === 0 && !recorder.active && !micState.stream) return;
    const g = await ensureGraph();
    if (!g) return;
    const now = karaokeEffects(); // the settings may have changed while the graph was loading
    const t = g.ctx.currentTime;
    g.dry.gain.setTargetAtTime(1 - now.remover, t, 0.02);
    g.wet.gain.setTargetAtTime(now.remover * 1.4, t, 0.02);
    g.bass.gain.setTargetAtTime(now.remover, t, 0.02);
    setPitch(g, now.semitones);
  }

  function setPitch(g, semis) {
    if (!g.pitch) return;
    const on = semis !== 0;
    g.pitch.port.postMessage({ ratio: Math.pow(2, semis / 12) });
    if (on && !g.pitchOn) {
      g.vrOut.connect(g.pitch);
      g.pitchOn = true;
    }
    const t = g.ctx.currentTime;
    g.bypass.gain.setTargetAtTime(on ? 0 : 1, t, 0.02);
    g.pitchGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
    if (!on && g.pitchOn) {
      g.pitchOn = false;
      setTimeout(() => {
        if (g.pitchOn) return;
        try {
          g.vrOut.disconnect(g.pitch);
        } catch {
          // Already disconnected.
        }
      }, 250);
    }
  }

  // Plays a short test tone through the effects graph. If it comes out silent, the system is blocking local audio
  // from Web Audio, and routing the real songs through it would silence them, so we must not do that.
  async function audioGraphAllowed(ctx) {
    try {
      const probe = new Audio('probe.wav');
      probe.loop = true;
      const src = ctx.createMediaElementSource(probe);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      await probe.play();
      await new Promise((r) => setTimeout(r, 500));
      const d = new Float32Array(1024);
      an.getFloatTimeDomainData(d);
      let peak = 0;
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      probe.pause();
      src.disconnect();
      return peak > 0.02;
    } catch {
      return false;
    }
  }

  // The audio graph is only built the first time a karaoke effect is needed, so normal playback is untouched.
  function ensureGraph() {
    if (graph) return Promise.resolve(graph);
    if (graphPromise) return graphPromise;
    graphPromise = (async () => {
      try {
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        await ctx.resume();
        if (!(await audioGraphAllowed(ctx))) {
          ctx.close();
          toast("Karaoke audio effects can't run on this system, so the voice remover, key change, and recording are off.");
          return null;
        }
        const input = ctx.createGain();
        players.forEach((p) => ctx.createMediaElementSource(p).connect(input));

        // Voice remover: subtract left from right to cancel what sits in the center, keep the bass untouched.
        const vrOut = ctx.createGain();
        const dry = ctx.createGain();
        input.connect(dry);
        dry.connect(vrOut);
        const split = ctx.createChannelSplitter(2);
        const gL = ctx.createGain();
        gL.gain.value = 0.5;
        const gR = ctx.createGain();
        gR.gain.value = -0.5;
        const side = ctx.createGain();
        input.connect(split);
        split.connect(gL, 0);
        split.connect(gR, 1);
        gL.connect(side);
        gR.connect(side);
        const hp1 = ctx.createBiquadFilter();
        hp1.type = 'highpass';
        hp1.frequency.value = 150;
        const hp2 = ctx.createBiquadFilter();
        hp2.type = 'highpass';
        hp2.frequency.value = 150;
        const wet = ctx.createGain();
        wet.gain.value = 0;
        side.connect(hp1);
        hp1.connect(hp2);
        hp2.connect(wet);
        wet.connect(vrOut);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 150;
        const bass = ctx.createGain();
        bass.gain.value = 0;
        input.connect(lp);
        lp.connect(bass);
        bass.connect(vrOut);
        dry.gain.value = 1;

        // Key change: runs through the pitch shifter only while a key shift is set.
        const musicOut = ctx.createGain();
        const bypass = ctx.createGain();
        vrOut.connect(bypass);
        bypass.connect(musicOut);
        let pitch = null;
        let pitchGain = null;
        try {
          await loadWorklet(ctx, 'pitch-worklet.js');
          pitch = new AudioWorkletNode(ctx, 'pitch-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
          pitchGain = ctx.createGain();
          pitchGain.gain.value = 0;
          pitch.connect(pitchGain);
          pitchGain.connect(musicOut);
        } catch {
          toast("Key change isn't available on this system.");
        }
        musicOut.connect(ctx.destination);

        const anIn = ctx.createAnalyser();
        anIn.fftSize = 1024;
        input.connect(anIn);
        const anSide = ctx.createAnalyser();
        anSide.fftSize = 1024;
        side.connect(anSide);

        graph = { ctx, input, dry, wet, bass, vrOut, bypass, pitch, pitchGain, pitchOn: false, musicOut, anIn, anSide, rec: null, buf: null };
        await ctx.resume();
        return graph;
      } catch {
        toast("Karaoke audio effects aren't available on this system.");
        return null;
      }
    })();
    return graphPromise;
  }

  // ----- Microphone and recording -----
  const micError = (e) =>
    e && e.name === 'NotAllowedError'
      ? 'Microphone access is blocked. In Windows Settings, open Privacy, Microphone, and allow desktop apps.'
      : e && e.name === 'NotFoundError'
      ? 'No microphone was found.'
      : "Couldn't open the microphone.";

  async function refreshMicDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      micState.devices = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    } catch {
      micState.devices = [];
    }
  }

  async function enableMic() {
    const g = await ensureGraph();
    if (!g) return false;
    const m = db.settings.mic;
    try {
      if (micState.stream) disableMic(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: m.deviceId ? { exact: m.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = g.ctx;
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = m.level / 100;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const monitor = ctx.createGain();
      monitor.gain.value = m.monitor ? m.monitorLevel / 100 : 0;
      src.connect(gain);
      gain.connect(analyser);
      gain.connect(monitor);
      monitor.connect(ctx.destination);
      if (g.rec) gain.connect(g.rec.mic);
      Object.assign(micState, { stream, src, gain, analyser, monitor, buf: new Float32Array(512) });
      await refreshMicDevices();
      renderMicGroup();
      return true;
    } catch (e) {
      toast(micError(e));
      return false;
    }
  }

  function disableMic(keepUi) {
    if (micState.stream) micState.stream.getTracks().forEach((t) => t.stop());
    for (const n of [micState.src, micState.gain, micState.analyser, micState.monitor]) {
      try {
        if (n) n.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    Object.assign(micState, { stream: null, src: null, gain: null, analyser: null, monitor: null, buf: null });
    if (!keepUi) renderMicGroup();
  }

  function updateMeter() {
    const bar = $('#kMeter i');
    if (!bar) return;
    if (!micState.analyser) {
      bar.style.width = '0%';
      return;
    }
    micState.analyser.getFloatTimeDomainData(micState.buf);
    let peak = 0;
    for (let i = 0; i < micState.buf.length; i++) peak = Math.max(peak, Math.abs(micState.buf[i]));
    bar.style.width = Math.min(100, Math.round(Math.sqrt(peak) * 100)) + '%';
  }

  // How far to delay the music in the recording so it lines up with your voice.
  function recSyncSeconds() {
    const m = db.settings.mic;
    if (typeof m.syncMs === 'number') return Math.max(0, Math.min(500, m.syncMs)) / 1000;
    const ctx = graph && graph.ctx;
    if (!ctx) return 0;
    const track = micState.stream && micState.stream.getAudioTracks()[0];
    const inLatency = (track && track.getSettings && track.getSettings().latency) || 0;
    return Math.min(0.5, (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + inLatency);
  }

  function renderMicGroup() {
    const box = $('#kMic');
    if (!box) return;
    const m = db.settings.mic;
    if (!micState.stream) {
      box.innerHTML = `<span class="lbl">Microphone</span>
        <button class="btn small" data-action="k-mic-on">Enable microphone</button>
        <span class="k-micnote">Use headphones when you sing so the mic doesn't pick up the music.</span>${savedHtml()}`;
      return;
    }
    const devices = micState.devices
      .map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === m.deviceId ? 'selected' : ''}>${esc(d.label || 'Microphone ' + (i + 1))}</option>`)
      .join('');
    const auto = typeof m.syncMs !== 'number';
    const syncMs = Math.round(recSyncSeconds() * 1000);
    box.innerHTML = `<span class="lbl">Mic</span>
      <select id="kMicSel" aria-label="Microphone">${devices}</select>
      <input type="range" id="kMicLevel" min="0" max="200" value="${m.level}" aria-label="Microphone level">
      <span class="k-meter" id="kMeter" title="Microphone level"><i></i></span>
      <label class="chk-row"><input type="checkbox" id="kMonitor" ${m.monitor ? 'checked' : ''}> Hear myself</label>
      <select id="kRecMode" aria-label="What to record">
        <option value="mix" ${m.recMode === 'mix' ? 'selected' : ''}>Record me + music</option>
        <option value="mic" ${m.recMode === 'mic' ? 'selected' : ''}>Record me only</option>
      </select>
      <button class="btn small k-rec ${recorder.active ? 'on' : ''}" id="kRec" data-action="k-rec">${recorder.active ? '<span class="rec-dot"></span><span id="kRecTime">0:00</span> Stop' : 'Record'}</button>
      <button class="btn small" data-action="k-mic-off">Turn off mic</button>
      <details class="k-micnote"><summary>Recording sync</summary>
        <span class="lbl">Delay the music in the recording by</span>
        <input type="range" id="kSync" min="0" max="400" value="${syncMs}" aria-label="Recording sync in milliseconds">
        <span class="k-val" id="kSyncVal">${syncMs} ms${auto ? ' (auto)' : ''}</span>
        <button class="btn small" data-action="k-sync-auto">Auto</button>
      </details>
      <span class="k-micnote">${m.monitor ? 'You are hearing yourself, so use headphones to avoid feedback. ' : ''}Recordings are saved as WAV files.</span>${savedHtml()}`;
  }

  function savedHtml() {
    return lastRecording
      ? `<span class="k-saved">Saved: ${esc(lastRecording.name)} <button class="btn small" data-action="k-show-rec">Share file</button></span>`
      : '';
  }

  async function ensureRecGraph() {
    const g = await ensureGraph();
    if (!g) return null;
    if (g.rec) return g.rec;
    try {
      await loadWorklet(g.ctx, 'recorder-worklet.js');
    } catch {
      toast("Recording isn't available on this system.");
      return null;
    }
    const ctx = g.ctx;
    const music = ctx.createGain();
    const delay = ctx.createDelay(1);
    const mic = ctx.createGain();
    const mix = ctx.createGain();
    g.musicOut.connect(music);
    music.connect(delay);
    delay.connect(mix);
    mic.connect(mix);
    const node = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    mix.connect(node);
    const sink = ctx.createGain(); // keeps the recorder running without making a sound
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    node.port.onmessage = (e) => {
      if (recorder.active || recorder.draining) recorder.chunks.push(new Int16Array(e.data));
    };
    g.rec = { music, delay, mic, mix, node };
    if (micState.gain) micState.gain.connect(mic);
    return g.rec;
  }

  // Builds a 16-bit stereo WAV file from the recorded chunks.
  function encodeWav(chunks, sampleRate) {
    let frames = 0;
    for (const c of chunks) frames += c.length / 2;
    const dataBytes = frames * 4;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buffer);
    const tag = (o, str) => {
      for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
    };
    tag(0, 'RIFF');
    v.setUint32(4, 36 + dataBytes, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 16, true);
    tag(36, 'data');
    v.setUint32(40, dataBytes, true);
    let o = 44;
    for (const c of chunks) {
      new Int16Array(buffer, o, c.length).set(c);
      o += c.length * 2;
    }
    return { buffer, frames };
  }

  async function startRecording() {
    const s = curSong();
    if (!s) {
      toast('Play a song first, then press Record.');
      return;
    }
    if (!micState.stream && !(await enableMic())) return;
    const rec = await ensureRecGraph();
    if (!rec) return;
    const m = db.settings.mic;
    rec.music.gain.value = m.recMode === 'mic' ? 0 : 1;
    rec.delay.delayTime.value = recSyncSeconds();
    Object.assign(recorder, { active: true, draining: false, chunks: [], songId: s.id, startedAt: Date.now(), lastT: audio.currentTime });
    rec.node.port.postMessage({ on: true });
    if (audio.paused) audio.play().catch(() => {});
    clearInterval(recorder.timer);
    recorder.timer = setInterval(() => {
      const el = $('#kRecTime');
      if (el) el.textContent = fmt((Date.now() - recorder.startedAt) / 1000);
    }, 500);
    renderMicGroup();
  }

  async function stopRecording() {
    if (!recorder.active) return;
    const song = byId.get(recorder.songId);
    recorder.active = false;
    recorder.draining = true;
    clearInterval(recorder.timer);
    const rec = graph && graph.rec;
    if (rec) {
      rec.node.port.postMessage({ on: false });
      rec.node.port.postMessage({ flush: true });
    }
    renderMicGroup();
    await new Promise((r) => setTimeout(r, 150)); // let the last chunk arrive
    recorder.draining = false;
    const chunks = recorder.chunks;
    recorder.chunks = [];
    const { buffer, frames } = encodeWav(chunks, graph.ctx.sampleRate);
    const seconds = frames / graph.ctx.sampleRate;
    if (seconds < 1) {
      toast('That recording was too short to keep.');
      return;
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
    const name = `${song ? song.title : 'Karaoke'} - ${song ? song.artist : 'Me'} (karaoke ${stamp})`;
    const res = await window.api.saveRecording({ name, data: buffer, folder: db.settings.recordFolder || '' });
    if (!res || !res.ok) {
      toast((res && res.error) || 'Could not save the recording.');
      return;
    }
    lastRecording = { name: res.path.split(/[\\/]/).pop(), path: res.path, seconds };
    toast(`Saved your recording (${fmt(seconds)})`);
    if (db.settings.recAddToLibrary) {
      const added = mergeSongs([
        {
          path: res.path,
          title: `${song ? song.title : 'Karaoke'} (karaoke)`,
          artist: song ? song.artist : 'Me',
          albumArtist: '',
          album: 'Karaoke recordings',
          year: d.getFullYear(),
          trackNo: 0,
          genre: 'Karaoke',
          duration: seconds,
          cover: song ? song.cover : '',
          edited: { title: true, artist: true, album: true, genre: true, cover: true },
        },
      ]);
      if (added.length) save();
    }
    renderMicGroup();
  }

  // ----- Online lyrics (LRCLIB) -----
  async function ensureOnlineAllowed() {
    if (db.settings.onlineLyrics) return true;
    const yes = await askChoice(
      'Get synced lyrics online',
      "This looks up lyrics on lrclib.net, a free lyrics service. It sends each song's title, artist, album, and length. It only happens when you ask for it, and you can turn it off in Settings.",
      [
        { label: 'Allow', value: true, primary: true },
        { label: 'Not now', value: false },
      ]
    );
    if (yes) {
      db.settings.onlineLyrics = true;
      save();
    }
    return !!yes;
  }

  // Looks up one song and stores what it finds. Returns 'synced', 'plain', 'none', or 'error'.
  async function lookupLyrics(s) {
    const r = await window.api.onlineLyrics({ title: s.title, artist: s.artist, album: s.album, duration: s.duration });
    if (r.status === 'synced') {
      s.lyrics = r.synced;
      return 'synced';
    }
    if (r.status === 'plain') {
      if (!s.lyrics) s.lyrics = r.plain;
      return 'plain';
    }
    return r.status === 'error' ? 'error' : 'none';
  }

  async function getLyricsFor(ids) {
    if (lyricsJob) {
      toast('Already looking up lyrics.');
      return;
    }
    const songs = ids.map((id) => byId.get(id)).filter((s) => s && !hasTimedLyrics(s));
    if (!songs.length) {
      toast('Those songs already have timed lyrics.');
      return;
    }
    if (!(await ensureOnlineAllowed())) return;
    if (songs.length > 25 && !confirm(`Look up lyrics for ${songs.length} songs? This can take a few minutes, and you can cancel anytime.`)) return;
    lyricsJob = { total: songs.length, done: 0, synced: 0, plain: 0, none: 0, errors: 0, cancel: false, last: '' };
    let streak = 0;
    let stopped = '';
    for (const s of songs) {
      if (lyricsJob.cancel) {
        stopped = 'Cancelled. ';
        break;
      }
      lyricsJob.last = s.title;
      updateLyricsProgress();
      const status = await lookupLyrics(s);
      if (status === 'error') {
        lyricsJob.errors++;
        streak++;
        if (streak >= 3) {
          stopped = "Stopped because lrclib.net couldn't be reached. ";
          break;
        }
      } else {
        streak = 0;
        lyricsJob[status]++;
      }
      lyricsJob.done++;
      await new Promise((r) => setTimeout(r, 250));
    }
    const j = lyricsJob;
    lyricsJob = null;
    save();
    render();
    const cur = curSong();
    if (cur && songs.includes(cur)) loadLyrics(cur);
    toast(`${stopped}Timed lyrics for ${j.synced}${j.plain ? `, plain only for ${j.plain}` : ''}${j.none ? `, nothing found for ${j.none}` : ''}.`);
  }

  // ----- Stage controls -----
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast("Couldn't go full screen."));
  }
  document.addEventListener('fullscreenchange', () => {
    $('#app').classList.toggle('k-full', !!document.fullscreenElement && karaokeOn());
    const b = $('#kFull');
    if (b) b.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
    if (karaokeOn()) applyControlsState();
  });

  // Inputs on the stage (sliders, selects, checkboxes). They update just their own piece of the page.
  document.addEventListener('input', (e) => {
    const id = e.target.id;
    const k = db.settings.karaoke;
    const m = db.settings.mic;
    if (id === 'kStrength') {
      k.strength = Number(e.target.value);
      $('#kStrengthVal').textContent = k.strength + '%';
      save();
      applyKaraokeAudio();
    } else if (id === 'kMicLevel') {
      m.level = Number(e.target.value);
      if (micState.gain) micState.gain.gain.value = m.level / 100;
      save();
    } else if (id === 'kSync') {
      m.syncMs = Number(e.target.value);
      $('#kSyncVal').textContent = m.syncMs + ' ms';
      if (graph && graph.rec) graph.rec.delay.delayTime.value = m.syncMs / 1000;
      save();
    }
  });
  document.addEventListener('change', (e) => {
    const id = e.target.id;
    const k = db.settings.karaoke;
    const m = db.settings.mic;
    if (id === 'kTempo') {
      k.tempo = Number(e.target.value);
      save();
      applyKaraokeAudio();
    } else if (id === 'kMicSel') {
      m.deviceId = e.target.value;
      save();
      enableMic();
    } else if (id === 'kMonitor') {
      m.monitor = e.target.checked;
      if (micState.monitor) micState.monitor.gain.value = m.monitor ? m.monitorLevel / 100 : 0;
      save();
      renderMicGroup();
    } else if (id === 'kRecMode') {
      m.recMode = e.target.value;
      save();
    }
  });

  // Buttons on the stage give up focus so the space bar still pauses the song.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.k-controls button, .k-top button');
    if (b) setTimeout(() => b.blur(), 0);
  });

  // Lets you add lyrics from inside the editor.
  $('#edGetLyrics').addEventListener('click', async () => {
    if (!editCtx || editCtx.ids.length !== 1) {
      toast('Edit one song at a time to look up its lyrics.');
      return;
    }
    const s = byId.get(editCtx.ids[0]);
    if (!s || !(await ensureOnlineAllowed())) return;
    toast('Looking up lyrics...');
    const r = await window.api.onlineLyrics({ title: s.title, artist: s.artist, album: s.album, duration: s.duration });
    if (r.status === 'synced' || r.status === 'plain') {
      $('#edLyrics').value = r.status === 'synced' ? r.synced : r.plain;
      if (editCtx) editCtx.lyricsTouched = true;
      toast(r.status === 'synced' ? 'Found timed lyrics. Press Save to keep them.' : 'Found lyrics without timing. Press Save to keep them.');
    } else toast(r.status === 'error' ? "Couldn't reach lrclib.net." : 'No lyrics found for this song.');
  });

  // ---------- Responsive layout ----------
  const closeSidebar = () => $('#app').classList.remove('sidebar-open');
  function initResponsive() {
    const player = $('#player');
    const setH = () => document.documentElement.style.setProperty('--player-h', player.offsetHeight + 'px');
    new ResizeObserver(setH).observe(player);
    setH();
    $('#btnMenu').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));
    document.addEventListener('click', (e) => {
      if ($('#app').classList.contains('sidebar-open') && !e.target.closest('#sidebar') && !e.target.closest('#btnMenu')) closeSidebar();
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 800) closeSidebar();
      if (karaokeOn()) applyControlsState();
    });
  }

  // ---------- Start ----------
  function applyLoadedSettings() {
    shuffle = !!db.settings.shuffle;
    repeat = ['off', 'all', 'one'].includes(db.settings.repeat) ? db.settings.repeat : 'off';
    gapless = db.settings.gapless !== false;
    const v = db.settings.volume ?? 0.8;
    players.forEach((p) => (p.volume = v));
    vol.value = v * 100;
    setFill(vol);
    syncTransport();
  }

  (async function init() {
    const loaded = await window.api.load();
    db = {
      songs: loaded.songs || [],
      playlists: (loaded.playlists || []).map(normalizePlaylist),
      settings: { ...defaultSettings(), ...(loaded.settings || {}) },
    };
    db.settings.sorts = { ...(db.settings.sorts || {}) };
    db.settings.karaoke = { ...defaultSettings().karaoke, ...(db.settings.karaoke || {}) };
    db.settings.mic = { ...defaultSettings().mic, ...(db.settings.mic || {}) };
    if (!db.settings.rpcClientId) db.settings.rpcClientId = DEFAULT_RPC_ID;
    db.songs.forEach((s) => {
      if (!s.id) s.id = uid();
    });
    reindex();
    window.api.onRpcStatus(showRpcStatus);
    initResponsive();
    applyLoadedSettings();
    seeks.forEach(setFill);
    updateSleepBtn();
    if (db.settings.rpcEnabled) window.api.rpcConfigure(true, db.settings.rpcClientId);
    render();
  })();
})();
