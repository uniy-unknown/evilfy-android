// Evilfy for Android: replaces the Electron main process (main.js / preload.js).
// It provides the same window.api the desktop UI expects, then loads app.js.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';
import { BackgroundMode } from '@anuradev/capacitor-background-mode';
import { parseBlob, selectCover } from 'music-metadata-browser';

const DIR = Directory.Data;
const LIB_FILE = 'library.json';
const AUDIO_EXT = /\.(mp3|flac|wav|ogg|m4a|aac|opus|wma|mp4|webm)$/i;
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
const EXT_IMG = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

let base = ''; // file:// URI of the app's data folder
let lastDb = null; // most recent library, used to match imported playlists to stored songs

const safe = (n) => String(n || 'file').replace(/[\\/:*?"<>|#%]+/g, '_').trim() || 'file';
const stem = (n) => String(n || '').replace(/\.[^./\\]+$/, '');
const extOf = (n) => (String(n || '').match(/\.[^./\\]+$/) || [''])[0].toLowerCase();
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop();

function say(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b) {
  const bin = atob(b);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Relative paths (music/..., covers/...) are what the UI stores. This turns one into a URL the WebView can play.
function fileUrl(rel) {
  if (!rel) return '';
  if (/^(https?|blob|data):/.test(rel)) return rel;
  const enc = String(rel).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  return Capacitor.convertFileSrc(base + '/' + enc);
}

// Large files are written in 3 MB pieces (a multiple of 3 so each piece is clean base64).
async function writeBytes(path, blob, directory = DIR) {
  const CH = 3 * 1024 * 1024;
  if (!blob.size) {
    await Filesystem.writeFile({ path, directory, data: '', recursive: true });
    return;
  }
  for (let off = 0; off < blob.size; off += CH) {
    const data = b64(new Uint8Array(await blob.slice(off, off + CH).arrayBuffer()));
    if (off === 0) await Filesystem.writeFile({ path, directory, data, recursive: true });
    else await Filesystem.appendFile({ path, directory, data });
  }
}

async function exists(path, directory = DIR) {
  try {
    await Filesystem.stat({ path, directory });
    return true;
  } catch {
    return false;
  }
}

function pickFile(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = !!multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...input.files]));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}

// ---- Tags and covers ----

async function saveCover(picture) {
  if (!picture || !picture.data) return '';
  try {
    const ext = IMG_EXT[String(picture.format || '').toLowerCase()] || '.jpg';
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', picture.data))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const rel = 'covers/' + hash + ext;
    if (!(await exists(rel))) await writeBytes(rel, new Blob([picture.data]));
    return rel;
  } catch {
    return '';
  }
}

async function readTags(blob, rel, fallbackTitle) {
  const song = {
    path: rel,
    title: fallbackTitle,
    artist: 'Unknown artist',
    albumArtist: '',
    album: '',
    year: 0,
    trackNo: 0,
    genre: '',
    duration: 0,
    cover: '',
  };
  try {
    const meta = await parseBlob(blob, { duration: true });
    const c = meta.common;
    if (c.title) song.title = c.title;
    if (c.artist) song.artist = c.artist;
    if (c.albumartist) song.albumArtist = c.albumartist;
    if (c.album) song.album = c.album;
    if (c.year) song.year = c.year;
    if (c.track && c.track.no) song.trackNo = c.track.no;
    if (c.genre && c.genre.length) song.genre = c.genre[0];
    if (meta.format.duration) song.duration = meta.format.duration;
    song.cover = await saveCover(selectCover(c.picture));
  } catch {
    // Unreadable tags: keep the file name as the title.
  }
  return song;
}

async function readStoredBlob(rel) {
  const res = await fetch(fileUrl(rel));
  if (!res.ok) throw new Error('missing');
  return res.blob();
}

async function readStored(rel) {
  const blob = await readStoredBlob(rel);
  return readTags(blob, rel, stem(baseName(rel)).replace(/^\d+-/, ''));
}

// ---- Adding music: songs are copied into the app's own storage so they always stay playable ----

async function importFiles(files) {
  const songs = [];
  let n = 0;
  for (const file of files) {
    n++;
    if (!AUDIO_EXT.test(file.name) && !/^audio\//.test(file.type)) continue;
    say(`Adding songs... ${n} of ${files.length}`);
    try {
      const rel = `music/${file.size}-${safe(file.name)}`;
      const have = await exists(rel);
      if (!have) await writeBytes(rel, file);
      songs.push(await readTags(file, rel, stem(file.name)));
    } catch {
      // Skip a file we can't copy.
    }
  }
  return songs;
}

// ---- Lyrics (online) ----

function pickBestLyrics(list, duration) {
  if (!Array.isArray(list) || !list.length) return null;
  const near = (r) => !duration || !r.duration || Math.abs(r.duration - duration) <= 4;
  const byLength = (a, b) => Math.abs((a.duration || 0) - (duration || 0)) - Math.abs((b.duration || 0) - (duration || 0));
  const synced = list.filter((r) => r.syncedLyrics && near(r));
  if (synced.length) return duration ? synced.sort(byLength)[0] : synced[0];
  const plain = list.filter((r) => r.plainLyrics && near(r));
  return plain.length ? plain.sort(byLength)[0] : null;
}

async function onlineLyrics(q) {
  const base = 'https://lrclib.net/api';
  const getJson = async (path, params) => {
    const res = await CapacitorHttp.get({ url: base + path, params, headers: { Accept: 'application/json' }, readTimeout: 12000, connectTimeout: 12000 });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw new Error(`The lyrics server said ${res.status}`);
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  };
  const artist = q.artist && q.artist !== 'Unknown artist' ? q.artist : '';
  try {
    let hit = null;
    if (artist && q.album && q.duration) {
      hit = await getJson('/get', { track_name: q.title, artist_name: artist, album_name: q.album, duration: String(Math.round(q.duration)) });
    }
    if (!hit || !hit.syncedLyrics) {
      const sp = { track_name: q.title };
      if (artist) sp.artist_name = artist;
      hit = pickBestLyrics(await getJson('/search', sp), q.duration) || hit;
    }
    if (!hit) return { status: 'none' };
    if (hit.syncedLyrics) return { status: 'synced', synced: hit.syncedLyrics, plain: hit.plainLyrics || '' };
    if (hit.plainLyrics) return { status: 'plain', plain: hit.plainLyrics };
    return { status: hit.instrumental ? 'instrumental' : 'none' };
  } catch (e) {
    return { status: 'error', message: String((e && e.message) || e) };
  }
}

// ---- Export / import ----

async function shareText(name, text) {
  const path = 'export/' + safe(name);
  await Filesystem.writeFile({ path, directory: Directory.Cache, data: text, encoding: Encoding.UTF8, recursive: true });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: name, files: [uri] });
}

function songMatcher() {
  const byName = new Map();
  for (const s of (lastDb && lastDb.songs) || []) {
    byName.set(stem(baseName(s.path)).replace(/^\d+-/, '').toLowerCase(), s);
  }
  return (entryPath, title, artist) => {
    const k = stem(baseName(entryPath)).toLowerCase();
    if (byName.has(k)) return byName.get(k);
    if (title) {
      for (const s of lastDb.songs) {
        if (s.title.toLowerCase() === title.toLowerCase() && (!artist || s.artist.toLowerCase() === artist.toLowerCase())) return s;
      }
    }
    return null;
  };
}

function parseM3U(text, name) {
  const match = songMatcher();
  const entries = [];
  let info = null;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/^#EXTINF:\s*-?\d+(?:\.\d+)?\s*,\s*(.*)$/i);
      if (m) info = m[1];
      continue;
    }
    let artist = '';
    let title = '';
    if (info) {
      const parts = info.split(' - ');
      if (parts.length > 1) {
        artist = parts.shift();
        title = parts.join(' - ');
      } else title = info;
    }
    const s = match(line, title, artist);
    entries.push({ path: s ? s.path : line, title, artist, exists: !!s });
    info = null;
  }
  return { kind: 'm3u', name, entries };
}

async function restoreLibrary(j) {
  const songs = [];
  for (const s of j.songs || []) {
    const song = { ...s };
    if (song.coverData) {
      song.cover = await saveCover({ data: fromB64(song.coverData.b64), format: EXT_IMG[song.coverData.ext] || 'image/jpeg' });
      delete song.coverData;
    } else song.cover = song.cover || '';
    songs.push(song);
  }
  return { kind: 'evilfy-library', songs, playlists: j.playlists || [], settings: j.settings || {} };
}

// ---- The API the UI calls ----

const api = {
  async load() {
    try {
      const r = await Filesystem.readFile({ path: LIB_FILE, directory: DIR, encoding: Encoding.UTF8 });
      lastDb = JSON.parse(r.data);
    } catch {
      lastDb = { songs: [], playlists: [], settings: { volume: 0.8 } };
    }
    return lastDb;
  },
  async save(data) {
    lastDb = data;
    await Filesystem.writeFile({ path: LIB_FILE, directory: DIR, data: JSON.stringify(data), encoding: Encoding.UTF8, recursive: true });
    return true;
  },
  async addFiles() {
    const files = await pickFile('audio/*,.mp3,.flac,.wav,.ogg,.m4a,.aac,.opus,.wma', true);
    if (!files.length) return [];
    const songs = await importFiles(files);
    say(songs.length ? `Added ${songs.length} song${songs.length === 1 ? '' : 's'}` : 'No songs found.');
    return songs;
  },
  async addFolder() {
    // Android's WebView can't pick folders; "Add songs" lets you select as many files as you like.
    return api.addFiles();
  },
  async addPaths(paths) {
    const out = [];
    for (const p of paths) if (await exists(p)) out.push(await readStored(p));
    return out;
  },
  async refresh(items) {
    const out = [];
    for (const item of items) {
      try {
        out.push({ ...(await readStored(item.path)), id: item.id });
      } catch {
        // File is gone.
      }
    }
    return out;
  },
  async showInFolder(p) {
    try {
      const { uri } = await Filesystem.getUri({ path: p, directory: DIR });
      await Share.share({ files: [uri] });
    } catch {
      // Sharing was cancelled or isn't possible.
    }
    return true;
  },
  async findLyrics(rel) {
    try {
      const meta = await parseBlob(await readStoredBlob(rel), { skipCovers: true, duration: false });
      const lyrics = meta.common.lyrics;
      if (lyrics && lyrics.length) {
        const first = lyrics[0];
        const text = typeof first === 'string' ? first : (first && first.text) || '';
        if (text) return { text, source: 'tag' };
      }
    } catch {
      // No readable tags.
    }
    return null;
  },
  async pickCover() {
    const [file] = await pickFile('image/*', false);
    if (!file) return '';
    return saveCover({ data: new Uint8Array(await file.arrayBuffer()), format: file.type || EXT_IMG[extOf(file.name)] || 'image/jpeg' });
  },
  async setMini() {
    return true;
  },
  async scanLrc() {
    return [];
  },
  onlineLyrics,
  async saveRecording({ name, data }) {
    try {
      const baseN = safe(name).replace(/\.wav$/i, '');
      let rel = `recordings/${baseN}.wav`;
      let n = 2;
      while (await exists(rel)) rel = `recordings/${baseN} (${n++}).wav`;
      await writeBytes(rel, new Blob([data]));
      return { ok: true, path: rel };
    } catch {
      return { ok: false, error: 'Could not save the recording.' };
    }
  },
  async workletSource(name) {
    if (!['pitch-worklet.js', 'recorder-worklet.js'].includes(name)) return '';
    return (await fetch(name)).text();
  },
  async exportLibrary(data) {
    try {
      const songs = [];
      for (const s of data.songs) {
        const copy = { ...s };
        if (s.edited && s.edited.cover && s.cover) {
          try {
            const buf = new Uint8Array(await (await readStoredBlob(s.cover)).arrayBuffer());
            copy.coverData = { ext: extOf(s.cover), b64: b64(buf) };
          } catch {
            // Cover file is gone; skip it.
          }
        }
        delete copy.cover;
        songs.push(copy);
      }
      const out = { format: 'evilfy-library', version: 1, exportedAt: new Date().toISOString(), songs, playlists: data.playlists, settings: data.settings };
      await shareText(`evilfy-library-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out));
      return { ok: true, count: songs.length };
    } catch {
      return { ok: false, error: 'Could not export the library.' };
    }
  },
  async exportPlaylist(payload) {
    try {
      const keepCats = window.confirm('Export as an Evilfy playlist (keeps categories)?\n\nOK = Evilfy playlist (.json)\nCancel = M3U8 (works in other players)');
      if (keepCats) {
        await shareText(safe(payload.name) + '.json', JSON.stringify({ format: 'evilfy-playlist', version: 1, ...payload.evilfy }, null, 2));
      } else {
        const lines = ['#EXTM3U'];
        for (const t of payload.tracks) {
          lines.push(`#EXTINF:${Math.round(t.duration) || -1},${t.artist} - ${t.title}`);
          lines.push(baseName(t.path).replace(/^\d+-/, ''));
        }
        await shareText(safe(payload.name) + '.m3u8', lines.join('\r\n') + '\r\n');
      }
      return { ok: true, count: payload.tracks.length };
    } catch {
      return { ok: false, error: 'Could not export the playlist.' };
    }
  },
  async readImport(_filePath, hint) {
    const [file] = await pickFile('*/*', false);
    if (!file) return null;
    try {
      const text = await file.text();
      const ext = extOf(file.name);
      if (ext === '.m3u' || ext === '.m3u8') return parseM3U(text, stem(file.name));
      const j = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (j.format === 'evilfy-playlist') {
        const match = songMatcher();
        const entries = (j.songs || []).map((s) => {
          const m = match(s.path, s.title, s.artist);
          return { ...s, path: m ? m.path : s.path, exists: !!m };
        });
        return { kind: 'evilfy-playlist', name: j.name || stem(file.name), entries, categories: j.categories || [], songCats: j.songCats || {}, activeCats: j.activeCats || [] };
      }
      if (j.format === 'evilfy-library') return restoreLibrary(j);
      return { error: "That file isn't an Evilfy playlist or backup." };
    } catch {
      return { error: "Couldn't read that file." };
    }
  },
  async checkFiles(paths) {
    const missing = [];
    for (const p of paths) if (!(await exists(p))) missing.push(p);
    return missing;
  },
  async pickFolder() {
    return '';
  },
  async indexFolder() {
    return [];
  },
  async rpcConfigure() {
    return true;
  },
  async rpcActivity() {
    return true;
  },
  async rpcStatus() {
    return 'off';
  },
  onRpcStatus() {},
  pathForFile() {
    return '';
  },
};

// ---- Android niceties: back button and playing in the background ----

function setupBackButton() {
  App.addListener('backButton', () => {
    const open = document.querySelector('dialog[open]');
    if (open) return open.close('cancel');
    const app = document.getElementById('app');
    if (app && app.classList.contains('sidebar-open')) return document.getElementById('btnMenu').click();
    for (const id of ['queuePanel', 'lyricsPanel']) {
      const el = document.getElementById(id);
      if (el && !el.hidden) return document.getElementById(id === 'queuePanel' ? 'btnQueue' : 'btnLyrics').click();
    }
    const back = document.getElementById('btnBack');
    if (back && !back.disabled) return back.click();
    App.minimizeApp();
  });
}

function setupBackgroundPlayback() {
  let enabled = false;
  let idle = null;
  const text = (id) => (document.getElementById(id) || {}).textContent || '';
  const notify = () => ({ title: text('npTitle') || 'Evilfy', text: text('npArtist') || 'Playing in the background' });
  const start = async () => {
    clearTimeout(idle);
    if (enabled) return;
    enabled = true;
    try {
      await BackgroundMode.requestNotificationsPermission();
    } catch {
      // Without it the service still runs; the notification just may not show.
    }
    try {
      await BackgroundMode.enable({ ...notify(), channelName: 'Evilfy playback', channelDescription: 'Keeps music playing with the screen off', silent: true, disableWebViewOptimization: true, resume: true, allowClose: false });
    } catch {
      enabled = false;
    }
  };
  const stopSoon = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      const playing = [...document.querySelectorAll('audio')].some((a) => !a.paused);
      if (!playing && enabled) {
        enabled = false;
        BackgroundMode.disable().catch(() => {});
      }
    }, 120000);
  };
  for (const a of document.querySelectorAll('audio')) {
    a.addEventListener('play', start);
    a.addEventListener('pause', stopSoon);
    a.addEventListener('ended', stopSoon);
  }
  const t = document.getElementById('npTitle');
  if (t) {
    new MutationObserver(() => {
      if (enabled) BackgroundMode.updateNotification(notify()).catch(() => {});
    }).observe(t, { childList: true, characterData: true, subtree: true });
  }
}

// ---- Start ----

async function boot() {
  for (const d of ['music', 'covers', 'recordings']) {
    try {
      await Filesystem.mkdir({ path: d, directory: DIR, recursive: true });
    } catch {
      // Already there.
    }
  }
  const { uri } = await Filesystem.getUri({ path: 'music', directory: DIR });
  base = uri.replace(/\/music\/?$/, '');
  window.__fileUrl = fileUrl;
  window.api = api;
  document.body.classList.add('android');
  setupBackButton();
  const s = document.createElement('script');
  s.src = 'app.js';
  s.onload = setupBackgroundPlayback;
  document.body.appendChild(s);
}

boot();
