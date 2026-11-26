/**
 * CANCIONERO — EDICIÓN UNIVERSAL SMART TV (LG webOS, Samsung Tizen, Android TV, Sony, Hisense, VIDAA, PC)
 * Compatibilidad estricta ES5/ES6 sin sintaxis moderna incompatible para funcionar en cualquier Smart TV antigua o moderna.
 */

// Polyfills para motores de Smart TV antiguos (Chromium 47-79 / webOS 3-5 / Tizen 3-5)
if (!Array.prototype.flat) {
  Array.prototype.flat = function(depth) {
    var d = depth !== undefined ? depth : 1;
    var flatted = [];
    (function flat(arr, currentDepth) {
      for (var i = 0; i < arr.length; i++) {
        if (Array.isArray(arr[i]) && currentDepth > 0) flat(arr[i], currentDepth - 1);
        else flatted.push(arr[i]);
      }
    })(this, d);
    return flatted;
  };
}

function on(idOrEl, event, handler) {
  if (!idOrEl) return;
  var el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if (el && el.addEventListener) {
    el.addEventListener(event, handler);
  }
}


// Estado Global TV
const tvState = {
  songs: [],
  filteredSongs: [],
  currentSong: null,
  activeBook: 'all',          // 'all' (orden Playlist #1 a #925), 'principal' o 'reggaeton'
  viewMode: 'word',           // 'word', 'pdf', 'karaoke'
  theme: 'oled',              // 'oled' (negro puro 0 nits) o 'white' (papel blanco)
  layout: 'split',            // 'split' (letra + video) o 'solo' (pantalla completa letra)
  stageMode: 'video',         // 'video' (reproductor YouTube completo 16:9) o 'poster' (portada HD sobre audio activo)
  wordCols: 2,                // 1, 2, 3 o 4 columnas
  zoomScale: 1.0,             // Escala de zoom (0.7 a 2.5)
  isPlaying: false,
  currentTimeSec: 0,
  durationSec: 0,
  currentVideoId: '',
  currentVideoCandidates: [],
  currentVideoCandidateIdx: 0,
  karaokeOffsetSec: 0.0,
  currentFilter: 'all',       // 'all', 'matched', 'unmatched'
  searchQuery: '',
  selectedArtist: '',
  currentPageIndex: 0,
  pdfPageOffset: 0,
  sidebarVisible: true,
  pdfDocs: {},
  pdfIndex: null,
  currentPdfRenderTask: null,
  pdfRenderSeq: 0,
  audioEl: null,
  ytPlayer: null,
  ytApiReady: false,
  ytPlayerReady: false,
  pendingVideoLoad: null,
  ytPollInterval: null,
  lastEndedTimestamp: 0,
  wantAutoPlay: false,
  isShuffle: false,
  isRepeat: false,
  shuffleQueue: [],
  shufflePointer: -1,
  shufflePlayedIds: new Set()
};

// Mapeo Canónico de Artistas
const CANONICAL_MAP = {
  'ska p': 'Ska-P', 'ska-p': 'Ska-P', 'el ultimo ke zierre': 'El Último Ke Zierre',
  'el último ke zierre': 'El Último Ke Zierre', 'kaos etilico': 'Kaos Etíliko',
  'kaos etílico': 'Kaos Etíliko', 'los delinquentes': 'Los Delinqüentes',
  'los delincuentes': 'Los Delinqüentes', 'los de marra': 'Los de Marras',
  'los de marras': 'Los de Marras', 'mago de oz': 'Mägo de Oz', 'mägo de oz': 'Mägo de Oz',
  'daddy': 'Daddy Yankee', 'daddy yankee': 'Daddy Yankee', 'arcangel': 'Arcangel',
  'rakim y ken-y': 'RKM & Ken-Y', 'rkm & ken-y': 'RKM & Ken-Y', 'wisin y yandel': 'Wisin & Yandel'
};

function normalizeArtist(name) {
  if (!name) return 'Desconocido';
  const clean = name.trim();
  const lower = clean.toLowerCase();
  if (CANONICAL_MAP[lower]) return CANONICAL_MAP[lower];
  return clean;
}

function normalizeSearch(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

// ==============================================================
// 1. SSoT ACTION & CLICK TRACKER
// ==============================================================
function logTvAction(action, details = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    source: 'tv_c4_oled_web',
    action: action,
    step: `Modo ${tvState.viewMode} · Libro ${tvState.activeBook}`,
    songId: tvState.currentSong ? tvState.currentSong.id : null,
    songTitle: tvState.currentSong ? `${tvState.currentSong.artist} - ${tvState.currentSong.title}` : null,
    details: details
  };

  try {
    var logs = JSON.parse(localStorage.getItem('ssot_tv_action_log') || '[]');
    logs.push(payload);
    if (logs.length > 150) logs = logs.slice(-150);
    localStorage.setItem('ssot_tv_action_log', JSON.stringify(logs));
  } catch (e) {}

  var host = (window.location && window.location.hostname) || '';
  if (host === 'localhost' || host === '127.0.0.1' || host.indexOf('192.168.') === 0) {
    fetch('/api/action-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function() {});
  }
}

// Captura automática de todos los clics y acciones en la interfaz TV
document.addEventListener('click', (e) => {
  const target = e.target.closest('button, a, input, select, .tv-song-item, .tv-karaoke-line');
  if (!target) return;
  const tag = target.tagName.toLowerCase();
  const label = (target.textContent || target.title || target.id || '').trim().slice(0, 40);
  logTvAction('tv_user_click', {
    element: tag,
    id: target.id || null,
    classes: target.className || null,
    label: label
  });
}, true);

function extractVideoId(url) {
  if (!url) return '';
  var str = String(url).trim();
  var match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([\w-]{11})/);
  if (match) return match[1];
  if (/^[\w-]{11}$/.test(str)) return str;
  return str;
}

function sortSongsByMasterPlaylistOrder(songsList) {
  if (!Array.isArray(songsList)) return [];

  // Mapear videoId -> posición oficial en la Playlist en vivo
  var playlistVidPos = new Map();
  if (window.STANDALONE_PLAYLIST && Array.isArray(window.STANDALONE_PLAYLIST)) {
    window.STANDALONE_PLAYLIST.forEach(function(item, idx) {
      var vid = extractVideoId(item.id || item.videoId || item.url);
      var pos = Number(item.index) || (idx + 1);
      if (vid && !playlistVidPos.has(vid)) {
        playlistVidPos.set(vid, pos);
      }
    });
  }

  songsList.forEach(function(s, idx) {
    s.artist = normalizeArtist(s.artist);
    var activeVid = extractVideoId(s.youtube || (s.matchedVideo && s.matchedVideo.id));
    if (activeVid && playlistVidPos.has(activeVid)) {
      var livePos = playlistVidPos.get(activeVid);
      s.playlistIndex = livePos;
      s.playlistOrder = livePos;
    } else if (typeof s.playlistIndex === 'number' && s.playlistIndex > 0) {
      s.playlistOrder = s.playlistIndex;
    } else if (typeof s.playlistOrder !== 'number') {
      s.playlistOrder = 9000 + (Number(s.order) || idx);
    }
  });

  songsList.sort(function(a, b) {
    var pa = typeof a.playlistOrder === 'number' ? a.playlistOrder : 9999;
    var pb = typeof b.playlistOrder === 'number' ? b.playlistOrder : 9999;
    if (pa !== pb) return pa - pb;
    return (Number(a.order) || 0) - (Number(b.order) || 0);
  });

  return songsList;
}

// ==============================================================
// 2. CONSTRUCCIÓN DE CANCIONES Y REPOSITORIO (SSoT)
// ==============================================================
function buildTvSongs(bookKey) {
  if (typeof bookKey === 'undefined') bookKey = 'all';

  var prinRaw = (window.STANDALONE_SONGS && Array.isArray(window.STANDALONE_SONGS))
    ? window.STANDALONE_SONGS.map(function(s) {
        return Object.assign({}, s, {
          book: s.book || 'principal',
          pdfFile: s.pdfFile || 'active_cancionero.pdf',
          artist: normalizeArtist(s.artist)
        });
      })
    : [];

  var regRaw = (window.STANDALONE_REGGAETON && Array.isArray(window.STANDALONE_REGGAETON))
    ? window.STANDALONE_REGGAETON.map(function(s) {
        return Object.assign({}, s, {
          book: s.book || 'reggaeton',
          pdfFile: s.pdfFile || 'reggaeton.pdf',
          artist: normalizeArtist(s.artist)
        });
      })
    : [];

  var falRaw = (window.STANDALONE_FALTANTES && Array.isArray(window.STANDALONE_FALTANTES))
    ? window.STANDALONE_FALTANTES.map(function(s) {
        return Object.assign({}, s, {
          book: s.book || 'faltantes',
          pdfFile: s.pdfFile || 'faltantes.pdf',
          artist: normalizeArtist(s.artist)
        });
      })
    : [];

  // Actualizar contadores
  var elAll = document.getElementById('tv-count-all');
  var elPrin = document.getElementById('tv-count-prin');
  var elReg = document.getElementById('tv-count-reg');
  var elFal = document.getElementById('tv-count-fal');
  var totalCombined = prinRaw.length + regRaw.length + falRaw.length;
  if (elAll) elAll.textContent = totalCombined;
  if (elPrin) elPrin.textContent = prinRaw.length;
  if (elReg) elReg.textContent = regRaw.length;
  if (elFal) elFal.textContent = falRaw.length;

  var combined = [];
  if (bookKey === 'reggaeton') {
    combined = regRaw;
  } else if (bookKey === 'principal') {
    combined = prinRaw;
  } else if (bookKey === 'faltantes') {
    combined = falRaw;
  } else {
    // Unificado: todos los cancioneros ordenados estrictamente por el orden de la playlist oficial
    combined = [].concat(prinRaw, regRaw, falRaw);
  }

  // Orden estricto de Playlist de YouTube Music ("el orden de la playlist es el que manda")
  return sortSongsByMasterPlaylistOrder(combined);
}

// ==============================================================
// MARCAS DE CANCIÓN: FAVORITAS + ACORDES MALOS + LETRA MALA + SINCRO MALA
// (misma clave de almacenamiento que la app web). En la TV NO se edita nada:
// solo se marcan fallas y se deja un registro para compartirlo al final.
// ==============================================================
var TV_MARKS_KEY = 'cancionero_song_marks_v1';
tvState.songMarks = {};
tvState.markFilter = 'all'; // 'all', 'fav', 'badChord', 'badLyric', 'badSync'

function tvEmptyMark() {
  return { fav: false, badChord: false, badLyric: false, badSync: false };
}

function loadTvSongMarks() {
  try {
    var raw = localStorage.getItem(TV_MARKS_KEY);
    tvState.songMarks = raw ? (JSON.parse(raw) || {}) : {};
  } catch (e) {
    tvState.songMarks = {};
  }
}

function saveTvSongMarks() {
  try { localStorage.setItem(TV_MARKS_KEY, JSON.stringify(tvState.songMarks || {})); } catch (e) {}
}

function getTvSongMark(song) {
  if (!song || !song.id) return tvEmptyMark();
  return (tvState.songMarks && tvState.songMarks[song.id]) || tvEmptyMark();
}

function toggleTvSongMark(markKey) {
  var song = tvState.currentSong;
  if (!song || !song.id) return;
  var prev = tvState.songMarks[song.id] || tvEmptyMark();
  var next = {
    fav: !!prev.fav,
    badChord: !!prev.badChord,
    badLyric: !!prev.badLyric,
    badSync: !!prev.badSync
  };
  next[markKey] = !prev[markKey];
  if (!next.fav && !next.badChord && !next.badLyric && !next.badSync) {
    delete tvState.songMarks[song.id];
  } else {
    tvState.songMarks[song.id] = next;
  }
  saveTvSongMarks();
  updateTvMarkButtons(song);
  filterTvSongs();

  var labels = {
    fav: next.fav ? '♥ Añadida a Favoritas' : '♡ Quitada de Favoritas',
    badChord: next.badChord ? '⚠️ Marcada: Acordes con error' : '✓ Desmarcado: Acordes',
    badLyric: next.badLyric ? '⚠️ Marcada: Letra con error' : '✓ Desmarcado: Letra',
    badSync: next.badSync ? '⚠️ Marcada: Sincronización mala' : '✓ Desmarcado: Sincronización'
  };
  showTvToast(labels[markKey] || 'Marca actualizada', 1600);
  logTvAction('tv_song_mark_toggled', { mark: markKey, value: next[markKey] });
}

function updateTvMarkButtons(song) {
  var mark = getTvSongMark(song);
  var bFav = document.getElementById('btn-tv-mark-fav');
  var bChord = document.getElementById('btn-tv-mark-bad-chord');
  var bLyric = document.getElementById('btn-tv-mark-bad-lyric');
  var bSync = document.getElementById('btn-tv-mark-bad-sync');
  if (bFav) {
    bFav.classList.toggle('active', !!mark.fav);
    bFav.innerHTML = mark.fav ? '♥ Favorita' : '♡ Favorita';
  }
  if (bChord) bChord.classList.toggle('active', !!mark.badChord);
  if (bLyric) bLyric.classList.toggle('active', !!mark.badLyric);
  if (bSync) bSync.classList.toggle('active', !!mark.badSync);
}

function updateTvMarkCounts() {
  var favC = 0, chordC = 0, lyricC = 0, syncC = 0;
  for (var i = 0; i < tvState.songs.length; i++) {
    var m = tvState.songMarks[tvState.songs[i].id];
    if (!m) continue;
    if (m.fav) favC++;
    if (m.badChord) chordC++;
    if (m.badLyric) lyricC++;
    if (m.badSync) syncC++;
  }
  var e1 = document.getElementById('count-mark-fav');
  var e2 = document.getElementById('count-mark-bad-chord');
  var e3 = document.getElementById('count-mark-bad-lyric');
  var e4 = document.getElementById('count-mark-bad-sync');
  if (e1) e1.textContent = favC;
  if (e2) e2.textContent = chordC;
  if (e3) e3.textContent = lyricC;
  if (e4) e4.textContent = syncC;
}
function filterTvSongs() {
  const q = normalizeSearch(tvState.searchQuery);
  const artist = tvState.selectedArtist;
  const filter = tvState.currentFilter;
  const markFilter = tvState.markFilter || 'all';

  tvState.filteredSongs = tvState.songs.filter(song => {
    // 1. Filtro por conexión
    if (filter === 'matched' && !song.matchedVideo) return false;
    if (filter === 'unmatched' && song.matchedVideo) return false;

    // 1.b Filtro por Favoritas / Reportes de error
    if (markFilter !== 'all') {
      const m = tvState.songMarks[song.id];
      if (!m || !m[markFilter]) return false;
    }

    // 2. Filtro por artista
    if (artist && song.artist !== artist) return false;

    // 3. Búsqueda de texto (#playlist, artista, título)
    if (q) {
      if (q.startsWith('#')) {
        const num = parseInt(q.slice(1), 10);
        if (!isNaN(num) && song.playlistIndex !== num) return false;
      } else {
        const full = normalizeSearch(`${song.artist} ${song.title} ${song.playlistIndex || ''}`);
        if (!full.includes(q)) return false;
      }
    }
    return true;
  });

  // Actualizar contadores de las tabs
  const tabAll = document.getElementById('count-tab-all');
  const tabMat = document.getElementById('count-tab-matched');
  const tabUnm = document.getElementById('count-tab-unmatched');
  if (tabAll) tabAll.textContent = tvState.songs.length;
  if (tabMat) tabMat.textContent = tvState.songs.filter(s => s.matchedVideo).length;
  if (tabUnm) tabUnm.textContent = tvState.songs.filter(s => !s.matchedVideo).length;
  updateTvMarkCounts();

  renderTvSongList();
}

function renderTvSongList() {
  const container = document.getElementById('tv-song-list');
  if (!container) return;

  if (tvState.filteredSongs.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:30px; color:#64748b;">No se encontraron canciones con ese criterio.</div>`;
    return;
  }

  const curId = tvState.currentSong ? tvState.currentSong.id : null;
  let html = '';

  tvState.filteredSongs.forEach((song, idx) => {
    const isActive = curId && song.id === curId;
    const isPlaying = isActive && tvState.isPlaying;
    const plIdx = song.playlistIndex ? `#${song.playlistIndex}` : `#${idx + 1}`;
    const badgeText = song.matchedVideo ? '🎵 Calzado' : 'Sin audio';
    const badgeCls = song.matchedVideo ? '' : 'unmatched';
    const mark = getTvSongMark(song);
    const markTags =
      (mark.fav ? '<span class="tv-mark-tag tv-mark-tag-fav" title="Favorita">♥</span>' : '') +
      (mark.badChord ? '<span class="tv-mark-tag tv-mark-tag-err" title="Acordes con error">Ac✗</span>' : '') +
      (mark.badLyric ? '<span class="tv-mark-tag tv-mark-tag-err" title="Letra con error">Lt✗</span>' : '') +
      (mark.badSync ? '<span class="tv-mark-tag tv-mark-tag-err" title="Sincronización mala">Sn✗</span>' : '');

    html += `
      <div class="tv-song-item ${isActive ? 'active' : ''} ${isPlaying ? 'playing' : ''}" 
           data-song-id="${song.id}" 
           tabindex="0"
           title="${escapeHtml(song.artist)}: ${escapeHtml(song.title)}">
        <span class="song-idx">${plIdx}</span>
        <div class="song-main">
          <div class="song-title-text">${escapeHtml(song.title)}</div>
          <div class="song-artist-text">${escapeHtml(song.artist)} ${markTags}</div>
        </div>
        <span class="song-meta-badge ${badgeCls}">${badgeText}</span>
      </div>
    `;
  });

  container.innerHTML = html;

  // Listeners de clic en canciones
  container.querySelectorAll('.tv-song-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.songId;
      selectTvSong(id, true);
    });
  });
}

function populateArtistFilter() {
  const select = document.getElementById('tv-artist-select');
  if (!select) return;

  const artists = Array.from(new Set(tvState.songs.map(s => s.artist))).sort((a, b) => a.localeCompare(b));
  let html = `<option value="">🎤 Todos los artistas (${artists.length})</option>`;
  artists.forEach(art => {
    html += `<option value="${escapeHtml(art)}">${escapeHtml(art)}</option>`;
  });
  select.innerHTML = html;
}

// ==============================================================
// 3. SELECCIÓN DE CANCIÓN Y GESTIÓN DE AUDIO / VIDEO
// ==============================================================
function selectTvSong(songId, autoPlay = true) {
  const song = tvState.songs.find(s => s.id === songId);
  if (!song) return;

  tvState.currentSong = song;
  tvState.currentPageIndex = 0;
  tvState.pdfPageOffset = 0;
  tvState.showingSpanish = false;

  // Cambio de canción = contenido nuevo: reinicia el control de estática OLED y vuelve al inicio de la hoja
  if (typeof tvTouchActivity === 'function') tvTouchActivity();
  var sheetScrollerEl = document.getElementById('tv-sheet-scroller');
  if (sheetScrollerEl) sheetScrollerEl.scrollTop = 0;
  const titleEl = document.getElementById('tv-song-title');
  const artistEl = document.getElementById('tv-song-artist');
  const badgePl = document.getElementById('tv-badge-playlist');
  const badgeTone = document.getElementById('tv-badge-tone');
  const badgePages = document.getElementById('tv-badge-pages');
  const versionsSelect = document.getElementById('tv-versions-select');

  if (titleEl) titleEl.textContent = song.title;
  if (artistEl) artistEl.textContent = `· ${song.artist}`;
  if (badgePl) {
    badgePl.textContent = song.playlistIndex ? `🎵 Playlist #${song.playlistIndex}` : '🎵 Sin playlist';
  }

  if (badgeTone) {
    if (song.tone) {
      badgeTone.textContent = `Tono: ${song.tone}`;
      badgeTone.style.display = 'inline-block';
    } else {
      badgeTone.style.display = 'none';
    }
  }

  if (badgePages) {
    if (tvState.viewMode === 'word') {
      badgePages.style.display = 'none';
    } else if (tvState.viewMode === 'karaoke') {
      badgePages.style.display = 'inline-block';
      badgePages.textContent = '🎤 Karaoke';
    } else {
      const pages = song.pages || [(song.raw_lines || [])];
      badgePages.style.display = 'inline-block';
      badgePages.textContent = pages.length > 1 ? `📄 ${pages.length} Págs.` : '📄 1 Pág.';
    }
  }

  // Selector de versiones alternativas
  if (versionsSelect) {
    const versions = song.youtubeVersions || [];
    if (versions.length > 1) {
      versionsSelect.style.display = 'inline-block';
      let vHtml = '';
      versions.forEach((v, vIdx) => {
        vHtml += `<option value="${v.id || v.videoId}">Versión ${vIdx + 1}: ${(v.title || '').slice(0, 30)}</option>`;
      });
      versionsSelect.innerHTML = vHtml;
      versionsSelect.value = (song.matchedVideo && song.matchedVideo.id) || versions[0].id;
    } else {
      versionsSelect.style.display = 'none';
    }
  }

  // Actualizar estado en la lista izquierda
  renderTvSongList();

  // Centrar la canción activa
  const activeItem = document.querySelector(`.tv-song-item[data-song-id="${song.id}"]`);
  if (activeItem) {
    activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Iniciar reproducción multimedia (Audio nativo local + Escenario TV)
  playTvMedia(song, autoPlay);

  // Renderizar la hoja actual (Word, PDF o Karaoke)
  renderCurrentTvSheet();

  // Renderizar los diagramas de acordes de guitarra bajo el reproductor
  renderTvChords(song);

  // Sincronizar botones de Favorita / Acorde ✗ / Letra ✗ / Sincro ✗
  updateTvMarkButtons(song);

  // Actualizar disponibilidad y contenido del panel de Tabs / Partitura sincronizada
  if (window.ScoreSplitManager && typeof window.ScoreSplitManager.onSongChanged === 'function') {
    try { window.ScoreSplitManager.onSongChanged(song); } catch (eSc) {}
  }

  // Actualizar indicador en pantalla apagada si está activa
  const oledNowPlaying = document.getElementById('tv-oled-now-playing');
  if (oledNowPlaying) {
    oledNowPlaying.textContent = `${song.artist} - ${song.title}`;
  }

  logTvAction('tv_song_selected', {
    songId: song.id,
    title: song.title,
    artist: song.artist,
    playlistIndex: song.playlistIndex,
    autoPlay: autoPlay
  });
}

// Mapa de recuperación de videoId para canciones sin enlace directo en las bases antiguas
var RECOVERED_VIDEO_MAP = {
  'electroduende_salgo_a_ver_la_calle': '_gcMdnoATwU',
  'todo_o_nada_desesperacion': 'xs2FcuLMhDc',
  'wisin_y_yandel_descara': 'PASU2LNkiSY'
};

function getSongVideoCandidates(song) {
  var list = [];
  if (!song) return list;

  function addVid(raw) {
    var vid = extractVideoId(raw);
    if (vid && list.indexOf(vid) === -1) list.push(vid);
  }

  if (song.matchedVideo && song.matchedVideo.id) addVid(song.matchedVideo.id);
  if (song.youtube) addVid(song.youtube);
  if (song.youtubeVersions && Array.isArray(song.youtubeVersions)) {
    for (var i = 0; i < song.youtubeVersions.length; i++) {
      var v = song.youtubeVersions[i];
      if (v) addVid(v.id || v.videoId || v.url);
    }
  }
  if (song.id && RECOVERED_VIDEO_MAP[song.id]) {
    addVid(RECOVERED_VIDEO_MAP[song.id]);
  }
  return list;
}

function getTrueRandomInt(maxExclusive) {
  if (maxExclusive <= 1) return 0;
  try {
    if (window.crypto && window.crypto.getRandomValues) {
      var arr = new Uint32Array(1);
      window.crypto.getRandomValues(arr);
      return arr[0] % maxExclusive;
    }
  } catch (e) {}
  return Math.floor(Math.random() * maxExclusive);
}

function fisherYatesShuffle(arr) {
  for (var j = arr.length - 1; j > 0; j--) {
    var rand = getTrueRandomInt(j + 1);
    var temp = arr[j];
    arr[j] = arr[rand];
    arr[rand] = temp;
  }
  return arr;
}

function tvHasActiveSongFilter() {
  return (tvState.currentFilter && tvState.currentFilter !== 'all') ||
         (tvState.markFilter && tvState.markFilter !== 'all') ||
         !!tvState.selectedArtist ||
         !!(tvState.searchQuery && String(tvState.searchQuery).trim());
}

function getActivePlayableList() {
  // La navegación (siguiente/anterior, automática y aleatoria) respeta SIEMPRE el filtro activo.
  // Si hay un filtro activo y no tiene canciones, no se cae al repertorio completo.
  var hasFilter = tvHasActiveSongFilter();
  var source = (tvState.filteredSongs && tvState.filteredSongs.length > 0)
    ? tvState.filteredSongs
    : (hasFilter ? [] : tvState.songs);
  var playable = [];
  var seenIds = {};
  var seenVids = {};
  for (var i = 0; i < source.length; i++) {
    var s = source[i];
    if (!s || seenIds[s.id]) continue;
    var vids = getSongVideoCandidates(s);
    if (vids.length === 0) continue; // Evitar caer en canciones sin audio en reproducción continua/aleatoria
    if (seenVids[vids[0]]) continue; // Evitar duplicados entre cancioneros
    seenIds[s.id] = true;
    seenVids[vids[0]] = true;
    playable.push(s.id);
  }
  if (playable.length === 0) {
    for (var k = 0; k < source.length; k++) {
      if (source[k] && !seenIds[source[k].id]) {
        seenIds[source[k].id] = true;
        playable.push(source[k].id);
      }
    }
  }
  return playable;
}

function ensureTvShuffleQueue(forceRebuild) {
  var playableIds = getActivePlayableList();
  if (playableIds.length === 0) {
    tvState.shuffleQueue = [];
    tvState.shufflePointer = -1;
    return;
  }

  var needsBuild = !!forceRebuild || !tvState.shuffleQueue || tvState.shuffleQueue.length === 0;
  if (!needsBuild) {
    // La cola debe corresponder EXACTAMENTE al repertorio/filtro activo (mismo tamaño y mismos elementos)
    if (tvState.shuffleQueue.length !== playableIds.length) {
      needsBuild = true;
    } else {
      for (var c = 0; c < tvState.shuffleQueue.length; c++) {
        if (playableIds.indexOf(tvState.shuffleQueue[c]) === -1) { needsBuild = true; break; }
      }
    }
  }

  if (needsBuild) {
    var curId = tvState.currentSong ? tvState.currentSong.id : null;
    var curInPool = !!curId && playableIds.indexOf(curId) !== -1;
    if (curInPool) tvState.shufflePlayedIds.add(curId);

    // Separar las canciones NO escuchadas aún de las ya escuchadas en esta sesión
    var unplayed = [];
    var alreadyPlayed = [];
    for (var i = 0; i < playableIds.length; i++) {
      var sid = playableIds[i];
      if (sid === curId) continue;
      if (tvState.shufflePlayedIds.has(sid)) {
        alreadyPlayed.push(sid);
      } else {
        unplayed.push(sid);
      }
    }

    // Si ya se escucharon todas las canciones de la lista, reiniciar ciclo evitando repetir la actual de inmediato
    if (unplayed.length === 0) {
      tvState.shufflePlayedIds.clear();
      if (curInPool) tvState.shufflePlayedIds.add(curId);
      unplayed = alreadyPlayed;
      alreadyPlayed = [];
    }

    fisherYatesShuffle(unplayed);
    fisherYatesShuffle(alreadyPlayed);

    var finalQueue = [];
    if (curInPool) {
      finalQueue.push(curId);
    }
    for (var u = 0; u < unplayed.length; u++) finalQueue.push(unplayed[u]);
    for (var a = 0; a < alreadyPlayed.length; a++) finalQueue.push(alreadyPlayed[a]);

    tvState.shuffleQueue = finalQueue;
    // Si la canción actual no pertenece al filtro, el puntero queda antes del primero para que "siguiente" salga del filtro
    tvState.shufflePointer = curInPool ? 0 : -1;
  }
}

function toggleTvShuffle() {
  tvState.isShuffle = !tvState.isShuffle;
  if (tvState.isShuffle) {
    ensureTvShuffleQueue(true);
    var totalCount = tvState.shuffleQueue.length;
    showTvToast('🔀 Modo Aleatorio real activado (' + totalCount + ' canciones sin repetir)', 2200);
    // Si no está reproduciendo nada aún, iniciar de inmediato con una canción aleatoria nueva
    if (!tvState.isPlaying && tvState.shuffleQueue.length > 1) {
      navigateTvSong(1, false);
    }
  } else {
    showTvToast('➡️ Modo Secuencial (orden estricto de Playlist)', 1600);
  }
  updateTvPlaybackModesUI();
}

function toggleTvRepeat() {
  tvState.isRepeat = !tvState.isRepeat;
  showTvToast(tvState.isRepeat ? '🔁 Repetir canción activado (bucle continuo)' : '➡️ Repetición desactivada', 1600);
  updateTvPlaybackModesUI();
}

function updateTvPlaybackModesUI() {
  var shuffleBtn = document.getElementById('btn-tv-shuffle');
  var repeatBtn = document.getElementById('btn-tv-repeat');
  if (shuffleBtn) shuffleBtn.classList.toggle('active', !!tvState.isShuffle);
  if (repeatBtn) repeatBtn.classList.toggle('active', !!tvState.isRepeat);
}

var tvLastManualNavTs = 0;

function navigateTvSong(delta, isAutoEnded) {
  if (typeof isAutoEnded === 'undefined') isAutoEnded = false;
  if (tvState.songs.length === 0) return;

  // Si la canción terminó y está activo Repetir, reiniciar la misma canción desde 0 inmediatamente
  if (isAutoEnded && tvState.isRepeat) {
    seekTvAbsolute(0);
    if (tvState.ytPlayer && tvState.ytPlayerReady) {
      try { tvState.ytPlayer.playVideo(); } catch (e) {}
    } else if (tvState.audioEl && tvState.audioEl.src) {
      tvState.audioEl.play().catch(function() {});
    }
    setTvPlayingState(true);
    showTvToast('🔁 Repitiendo canción', 1200);
    return;
  }

  // Antirrebote de 380 ms en navegación manual (el control remoto repite teclas)
  if (!isAutoEnded) {
    var nowTs = Date.now();
    if (nowTs - tvLastManualNavTs < 380) return;
    tvLastManualNavTs = nowTs;
  }

  // La navegación siempre ocurre DENTRO del filtro activo
  var navList = (tvState.filteredSongs && tvState.filteredSongs.length > 0)
    ? tvState.filteredSongs
    : (tvHasActiveSongFilter() ? [] : tvState.songs);
  if (navList.length === 0) {
    showTvToast('⚠️ El filtro activo no tiene canciones para navegar', 2200);
    return;
  }

  // 1. Modo Aleatorio (Shuffle): Garantiza escuchar TODAS las canciones del filtro sin repetición
  if (tvState.isShuffle) {
    ensureTvShuffleQueue(false);
    var qLen = tvState.shuffleQueue.length;
    if (qLen > 0) {
      var nextPtr;
      if (delta > 0) {
        nextPtr = tvState.shufflePointer < 0 ? 0 : tvState.shufflePointer + 1;
      } else {
        nextPtr = tvState.shufflePointer <= 0 ? qLen - 1 : tvState.shufflePointer - 1;
      }
      if (nextPtr >= qLen) {
        // Se completó el 100% del ciclo: re-barajar limpiamente sin repetir la última canción
        tvState.shufflePlayedIds.clear();
        ensureTvShuffleQueue(true);
        qLen = tvState.shuffleQueue.length;
        nextPtr = qLen > 1 ? 1 : 0;
      }
      tvState.shufflePointer = nextPtr;
      var nextId = tvState.shuffleQueue[tvState.shufflePointer];
      var nextShuffleSong = null;
      for (var si = 0; si < tvState.songs.length; si++) {
        if (tvState.songs[si].id === nextId) { nextShuffleSong = tvState.songs[si]; break; }
      }
      if (nextShuffleSong) {
        tvState.shufflePlayedIds.add(nextShuffleSong.id);
        showTvToast('🔀 [' + (tvState.shufflePointer + 1) + '/' + qLen + '] ' + nextShuffleSong.artist + ' - ' + nextShuffleSong.title, 1800);
        selectTvSong(nextShuffleSong.id, true);
        return;
      }
    }
  }

  // 2. Modo Secuencial (sobre la lista activa filtrada, saltando canciones sin pista si terminó sola)
  var curId = tvState.currentSong ? tvState.currentSong.id : null;
  var currentIdx = -1;
  for (var ci = 0; ci < navList.length; ci++) {
    if (navList[ci].id === curId) { currentIdx = ci; break; }
  }
  var step = delta >= 0 ? 1 : -1;
  // Si la canción actual no está en el filtro, "siguiente" entra por el primero y "anterior" por el último
  var nextIdx = currentIdx === -1 ? (step > 0 ? -1 : 0) : currentIdx;
  for (var tries = 0; tries < navList.length; tries++) {
    nextIdx = (nextIdx + step + navList.length) % navList.length;
    var cand = navList[nextIdx];
    if (!isAutoEnded || getSongVideoCandidates(cand).length > 0) {
      selectTvSong(cand.id, true);
      return;
    }
  }
  selectTvSong(navList[0].id, true);
}

// ==============================================================
// 4. MOTOR UNIVERSAL YOUTUBE IFRAME API (100% INDEPENDIENTE DEL PC + REPRODUCCIÓN CONTINUA)
// ==============================================================
window.onYouTubeIframeAPIReady = function() {
  tvState.ytApiReady = true;
  if (tvState.pendingVideoLoad) {
    var pending = tvState.pendingVideoLoad;
    tvState.pendingVideoLoad = null;
    loadYouTubeVideoInPlayer(pending.videoId, pending.autoPlay);
  }
};

function startYtProgressPolling() {
  if (tvState.ytPollInterval) clearInterval(tvState.ytPollInterval);
  tvState.ytPollInterval = setInterval(function() {
    if (!tvState.ytPlayer || !tvState.ytPlayerReady) return;
    try {
      var st = tvState.ytPlayer.getPlayerState ? tvState.ytPlayer.getPlayerState() : -1;
      if (st === 1) { // PLAYING
        var cur = tvState.ytPlayer.getCurrentTime ? tvState.ytPlayer.getCurrentTime() : 0;
        var dur = tvState.ytPlayer.getDuration ? tvState.ytPlayer.getDuration() : 0;
        if (dur > 0) {
          tvState.currentTimeSec = cur;
          tvState.durationSec = dur;
          tvState.ytClockPerfMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          updateTvTimeUI();
          if (tvState.viewMode === 'karaoke') {
            autoScaleKaraokeToLiveDuration(dur);
            syncTvKaraoke(cur);
          }
        }
      }
    } catch (e) {}
  }, 100);
}

function autoScaleKaraokeToLiveDuration(liveDur) {
  if (!tvState.karaokeSyncCtrl || !tvState.karaokeSyncCtrl.lines || !liveDur || liveDur < 30) return;
  if (!tvState.karaokeIsEstimated || tvState.karaokeScaledToDur) return;
  var baseDur = tvState.karaokeBaseDur || 185;
  var ratio = liveDur / Math.max(30, baseDur);
  if (Math.abs(1 - ratio) < 0.05) {
    tvState.karaokeScaledToDur = true;
    return;
  }
  tvState.karaokeScaledToDur = true;
  var lines = tvState.karaokeSyncCtrl.lines;
  for (var i = 0; i < lines.length; i++) {
    lines[i].start = +(lines[i].start * ratio).toFixed(1);
    lines[i].end = +(lines[i].end * ratio).toFixed(1);
    if (Array.isArray(lines[i].words)) {
      for (var w = 0; w < lines[i].words.length; w++) {
        lines[i].words[w].start = +(lines[i].words[w].start * ratio).toFixed(1);
      }
    }
  }
}

function handleTvSongEnded() {
  var now = Date.now();
  if (now - tvState.lastEndedTimestamp < 1500) return; // Evitar doble disparo
  tvState.lastEndedTimestamp = now;
  setTvPlayingState(false);
  navigateTvSong(1, true);
}

function handleYtPlaybackError(errCode) {
  console.warn('[YouTube Player Error]', errCode, 'videoId:', tvState.currentVideoId);
  // Intentar automáticamente la siguiente versión disponible de la misma canción
  if (tvState.currentVideoCandidates && tvState.currentVideoCandidateIdx + 1 < tvState.currentVideoCandidates.length) {
    tvState.currentVideoCandidateIdx++;
    var altVid = tvState.currentVideoCandidates[tvState.currentVideoCandidateIdx];
    tvState.currentVideoId = altVid;
    showTvToast('🔄 Probando versión alternativa de YouTube...', 2200);
    loadYouTubeVideoInPlayer(altVid, true);
    // El calce del karaoke depende del video exacto: recargar la hoja con la sincronización de la nueva versión
    if (tvState.viewMode === 'karaoke') renderCurrentTvSheet();
    return;
  }

  // Si todas las versiones de la canción están bloqueadas por derechos de inserción en YouTube
  showTvToast('⚠️ Esta canción tiene restricción de YouTube. Pasando a la siguiente...', 3000);
  logTvAction('tv_youtube_all_versions_blocked', {
    songId: tvState.currentSong ? tvState.currentSong.id : '',
    videoId: tvState.currentVideoId,
    errorCode: errCode
  });

  if (tvState.wantAutoPlay) {
    setTimeout(function() {
      navigateTvSong(1, true);
    }, 2200);
  } else {
    setTvPlayingState(false);
  }
}

function ensureYouTubePlayer(initialVideoId, autoPlay) {
  var target = document.getElementById('tv-yt-player-target');
  if (!target) return;

  if (!window.YT || !window.YT.Player) {
    tvState.pendingVideoLoad = { videoId: initialVideoId, autoPlay: autoPlay };
    return;
  }

  // Si ya existe el reproductor persistente, reutilizarlo para garantizar reproducción continua sin cortes ni bloqueos de autoplay
  if (tvState.ytPlayer && tvState.ytPlayerReady) {
    try {
      if (autoPlay) {
        tvState.ytPlayer.loadVideoById(initialVideoId);
        // Refuerzo de reproducción inmediata por si el navegador queda en estado CUED
        setTimeout(function() {
          try {
            if (tvState.wantAutoPlay && tvState.ytPlayer && tvState.ytPlayer.getPlayerState && tvState.ytPlayer.getPlayerState() !== 1) {
              tvState.ytPlayer.playVideo();
            }
          } catch (e) {}
        }, 600);
      } else {
        tvState.ytPlayer.cueVideoById(initialVideoId);
      }
      return;
    } catch (e) {
      console.warn('[YT] Reiniciando instancia de reproductor:', e.message);
    }
  }

  // Crear la instancia persistente de YT.Player
  target.innerHTML = '<div id="tv-yt-iframe-mount" style="width:100%;height:100%;"></div>';
  tvState.ytPlayerReady = false;
  tvState.pendingVideoLoad = { videoId: initialVideoId, autoPlay: autoPlay };

  var playerVars = {
    autoplay: autoPlay ? 1 : 0,
    controls: 1,
    rel: 0,
    modestbranding: 1,
    playsinline: 1,
    iv_load_policy: 3,
    enablejsapi: 1
  };
  if (window.location && window.location.protocol && window.location.protocol.indexOf('http') === 0) {
    playerVars.origin = window.location.origin;
  }

  tvState.ytPlayer = new window.YT.Player('tv-yt-iframe-mount', {
    width: '100%',
    height: '100%',
    videoId: initialVideoId,
    playerVars: playerVars,
    events: {
      onReady: function(event) {
        tvState.ytPlayerReady = true;
        try { event.target.setVolume(100); } catch (e) {}
        startYtProgressPolling();
        if (tvState.pendingVideoLoad) {
          var p = tvState.pendingVideoLoad;
          tvState.pendingVideoLoad = null;
          if (p.videoId !== initialVideoId) {
            if (p.autoPlay) event.target.loadVideoById(p.videoId);
            else event.target.cueVideoById(p.videoId);
          } else if (p.autoPlay) {
            event.target.playVideo();
          }
        }
      },
      onStateChange: function(event) {
        var state = event.data;
        if (state === 1) { // PLAYING
          setTvPlayingState(true);
          try {
            var dur = event.target.getDuration();
            if (dur > 0) {
              tvState.durationSec = dur;
              updateTvTimeUI();
            }
          } catch (e) {}
        } else if (state === 2) { // PAUSED
          setTvPlayingState(false);
        } else if (state === 0) { // ENDED
          handleTvSongEnded();
        }
      },
      onError: function(event) {
        handleYtPlaybackError(event.data);
      }
    }
  });
}

function loadYouTubeVideoInPlayer(videoId, autoPlay) {
  if (!videoId) return;
  tvState.wantAutoPlay = !!autoPlay;
  ensureYouTubePlayer(videoId, !!autoPlay);
}

function initTvAudioEngine() {
  tvState.audioEl = document.getElementById('tv-native-audio');
  if (tvState.audioEl) {
    try { tvState.audioEl.pause(); tvState.audioEl.src = ''; } catch (e) {}
  }

  // Verificar si la API de YouTube ya terminó de cargar antes de initTvApp
  if (window.YT && window.YT.Player) {
    tvState.ytApiReady = true;
  }
}

function playTvMedia(song, autoPlay) {
  if (typeof autoPlay === 'undefined') autoPlay = true;
  var candidates = getSongVideoCandidates(song);
  tvState.currentVideoCandidates = candidates;
  tvState.currentVideoCandidateIdx = 0;

  var videoId = candidates.length > 0 ? candidates[0] : '';
  tvState.currentVideoId = videoId;
  tvState.currentTimeSec = 0;
  tvState.durationSec = 0;
  updateTvTimeUI();

  var trackInfo = document.getElementById('tv-player-track-info');
  var openYtBtn = document.getElementById('btn-tv-open-yt');

  if (trackInfo && song) {
    var plStr = song.playlistIndex ? '#' + song.playlistIndex + ' · ' : '';
    trackInfo.textContent = plStr + song.artist + ' - ' + song.title;
  }

  if (openYtBtn) {
    if (videoId) {
      openYtBtn.href = 'https://www.youtube.com/watch?v=' + videoId;
      openYtBtn.style.display = 'inline-flex';
    } else {
      var q = encodeURIComponent((song ? (song.artist + ' ' + song.title) : ''));
      openYtBtn.href = 'https://www.youtube.com/results?search_query=' + q;
      openYtBtn.style.display = 'inline-flex';
    }
  }

  if (!videoId) {
    clearTvMedia();
    showTvToast('⚠️ Esta canción aún no tiene video asignado en la playlist.', 2500);
    return;
  }

  // Cargar y reproducir en el reproductor persistente de YouTube
  loadYouTubeVideoInPlayer(videoId, autoPlay);

  // Actualizar portada overlay si el usuario tiene activado el modo Portada
  updateTvPosterOverlay(song, videoId);
}

function clearTvMedia() {
  tvState.wantAutoPlay = false;
  if (tvState.ytPlayer && tvState.ytPlayerReady) {
    try { tvState.ytPlayer.stopVideo(); } catch (e) {}
  }
  if (tvState.audioEl) {
    try { tvState.audioEl.pause(); tvState.audioEl.src = ''; } catch (e) {}
  }
  var overlay = document.getElementById('tv-poster-overlay');
  if (overlay) {
    overlay.style.display = 'flex';
    overlay.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#050810;color:#94a3b8;font-weight:700;padding:16px;text-align:center;">Sin pista de YouTube asignada</div>';
  }
  setTvPlayingState(false);
}

function updateTvPosterOverlay(song, videoId) {
  var stage = document.getElementById('tv-video-stage');
  if (!stage) return;

  var overlay = document.getElementById('tv-poster-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tv-poster-overlay';
    overlay.className = 'tv-poster-overlay';
    stage.appendChild(overlay);
  }

  if (tvState.stageMode === 'poster' && song && videoId) {
    var thumbUrl = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';
    overlay.style.display = 'block';
    overlay.innerHTML =
      '<div class="tv-audio-card" id="tv-stage-card" style="background-image: url(\'' + thumbUrl + '\');">' +
        '<div class="tv-audio-card-content">' +
          '<div class="tv-audio-info">' +
            '<span class="tv-audio-badge">🟢 Audio YouTube Oficial</span>' +
            '<div class="tv-audio-title">' + escapeHtml(song.title) + '</div>' +
            '<div class="tv-audio-artist">' + escapeHtml(song.artist) + '</div>' +
          '</div>' +
          '<div class="tv-equalizer ' + (tvState.isPlaying ? 'playing' : '') + '" id="tv-stage-equalizer">' +
            '<div class="tv-eq-bar"></div><div class="tv-eq-bar"></div><div class="tv-eq-bar"></div><div class="tv-eq-bar"></div><div class="tv-eq-bar"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    on('tv-stage-card', 'click', toggleTvPlayPause);
  } else {
    overlay.style.display = 'none';
  }
}

function renderTvStage(song, videoId) {
  updateTvPosterOverlay(song, videoId);
}

function setTvStageMode(mode) {
  tvState.stageMode = mode;
  var btn = document.getElementById('btn-toggle-video-mode');
  var icon = document.getElementById('video-mode-icon');
  var text = document.getElementById('video-mode-text');

  if (btn) btn.classList.toggle('active', mode === 'video');
  if (icon) icon.textContent = mode === 'video' ? '📻' : '🎬';
  if (text) text.textContent = mode === 'video' ? 'Ver Portada' : 'Ver Video';

  // Nunca destruimos el YT.Player al alternar Video/Portada, así la música jamás se corta
  updateTvPosterOverlay(tvState.currentSong, tvState.currentVideoId);
}

function toggleTvPlayPause() {
  if (!tvState.currentVideoId) {
    if (tvState.currentSong) playTvMedia(tvState.currentSong, true);
    return;
  }

  if (tvState.ytPlayer && tvState.ytPlayerReady) {
    try {
      var st = tvState.ytPlayer.getPlayerState ? tvState.ytPlayer.getPlayerState() : -1;
      if (st === 1) {
        tvState.wantAutoPlay = false;
        tvState.ytPlayer.pauseVideo();
        setTvPlayingState(false);
      } else {
        tvState.wantAutoPlay = true;
        tvState.ytPlayer.playVideo();
        setTvPlayingState(true);
      }
      return;
    } catch (e) {}
  }

  if (tvState.currentSong) {
    playTvMedia(tvState.currentSong, true);
  }
}

function setTvPlayingState(playing) {
  tvState.isPlaying = playing;
  var playIcon = document.getElementById('tv-icon-play');
  var pauseIcon = document.getElementById('tv-icon-pause');
  if (playIcon) playIcon.style.display = playing ? 'none' : 'block';
  if (pauseIcon) pauseIcon.style.display = playing ? 'block' : 'none';

  // Animación del ecualizador en la tarjeta
  var eq = document.getElementById('tv-stage-equalizer');
  if (eq) eq.classList.toggle('playing', playing);

  // Indicador en lista izquierda
  var activeItem = document.querySelector('.tv-song-item.active');
  if (activeItem) {
    activeItem.classList.toggle('playing', playing);
  }

  // Protección OLED Dinámica: si está reproduciendo, programar ocultamiento de barra superior
  if (playing) {
    scheduleHeaderAutoHide();
  } else {
    showHeaderBar();
  }
}

function seekTvRelative(deltaSec) {
  var baseTime = tvState.currentTimeSec || 0;
  var dur = tvState.durationSec || 9999;
  if (tvState.ytPlayer && tvState.ytPlayerReady) {
    try {
      baseTime = tvState.ytPlayer.getCurrentTime ? tvState.ytPlayer.getCurrentTime() : baseTime;
      dur = tvState.ytPlayer.getDuration ? (tvState.ytPlayer.getDuration() || dur) : dur;
    } catch (e) {}
  }
  var targetTime = Math.max(0, Math.min(dur, baseTime + deltaSec));
  seekTvAbsolute(targetTime);
}

function seekTvAbsolute(sec) {
  if (tvState.ytPlayer && tvState.ytPlayerReady) {
    try {
      tvState.ytPlayer.seekTo(sec, true);
    } catch (e) {}
  }
  tvState.currentTimeSec = sec;
  updateTvTimeUI();
}

function updateTvTimeUI() {
  const curEl = document.getElementById('tv-time-current');
  const totEl = document.getElementById('tv-time-total');
  const slider = document.getElementById('tv-seek-slider');

  if (curEl) curEl.textContent = formatTime(tvState.currentTimeSec);
  if (totEl && tvState.durationSec > 0) totEl.textContent = formatTime(tvState.durationSec);

  if (slider && tvState.durationSec > 0) {
    slider.value = Math.min(1000, Math.floor((tvState.currentTimeSec / tvState.durationSec) * 1000));
  }
}

// Sincronización en tiempo real del Karaoke en TV (Motor Unificado KaraokeSyncController v4.0)
function syncTvKaraoke(sec) {
  if (tvState.viewMode !== 'karaoke') return;
  if (tvState.karaokeSyncCtrl && tvState.karaokeSyncCtrl.updateActiveLine) {
    tvState.karaokeSyncCtrl.updateActiveLine(sec, false);
  }
}

// ==============================================================
// 5. RENDERIZADO DE HOJAS (WORD, PDF, KARAOKE)
// ==============================================================
function renderCurrentTvSheet() {
  const song = tvState.currentSong;
  const renderBox = document.getElementById('tv-sheet-render-box');
  const syncBar = document.getElementById('tv-karaoke-sync-controls');
  const colsSelector = document.getElementById('tv-cols-selector');

  if (!song || !renderBox) return;

  // Selector segmentado de idioma (Original / Español) para canciones con traducción
  updateTvLangToggleUI(song);

  renderBox.innerHTML = '';

  if (tvState.viewMode === 'word') {
    if (syncBar) syncBar.style.display = 'none';
    if (colsSelector) colsSelector.style.display = 'flex';
    renderTvWordSheet(song, renderBox);
  } else if (tvState.viewMode === 'karaoke') {
    if (syncBar) syncBar.style.display = 'flex';
    if (colsSelector) colsSelector.style.display = 'none';
    renderTvKaraokeSheet(song, renderBox);
  } else if (tvState.viewMode === 'pdf') {
    if (syncBar) syncBar.style.display = 'none';
    if (colsSelector) colsSelector.style.display = 'none';
    renderTvPdfSheet(song, renderBox);
  }
}

function isLikelyChordLine(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const words = trimmed.split(/\s+/);
  const chordRegex = /^[A-G][b#]?(m|maj|min|dim|aug|sus|add)?[0-9]?((\/[A-G][b#]?)|\+|-|°)?$/i;
  const latinChordRegex = /^(DO|RE|MI|FA|SOL|LA|SI)[b#]?(m|maj|min|dim|aug|sus|add)?[0-9]?((\/(DO|RE|MI|FA|SOL|LA|SI)[b#]?)|\+|-|°)?$/i;
  let matches = 0;
  for (const w of words) {
    const clean = w.replace(/[(),.–\-\/]/g, '').trim();
    if (clean && (chordRegex.test(clean) || latinChordRegex.test(clean))) {
      matches++;
    }
  }
  return matches >= 1 && (matches / words.length) >= 0.45;
}

function renderTvWordSheet(song, renderBox) {
  const activePages = (tvState.showingSpanish && song.spanishVersion && song.spanishVersion.pages)
    ? song.spanishVersion.pages
    : ((song.pages && song.pages.length > 0) ? song.pages : [(song.raw_lines || [])]);
  const pages = activePages;

  // En modo Word NO existen páginas ni paginador: siempre se muestra de forma continua y fija (sin movimiento)
  const pageNav = document.getElementById('tv-page-nav');
  if (pageNav) {
    pageNav.style.display = 'none';
  }
  const badgePages = document.getElementById('tv-badge-pages');
  if (badgePages) {
    badgePages.style.display = 'none';
  }

  // Unir todas las hojas en un solo flujo continuo eliminando encabezados de título repetidos entre páginas
  const continuousLines = [];
  const normTitleKey = cleanTvPdfMatch((song.artist || '') + (song.title || ''));
  for (let p = 0; p < pages.length; p++) {
    const pageArr = pages[p] || [];
    for (let li = 0; li < pageArr.length; li++) {
      const item = pageArr[li];
      const txt = typeof item === 'string' ? item : (item && item.text ? item.text : '');
      if (p > 0 && li <= 2 && txt.trim()) {
        const cleanLine = cleanTvPdfMatch(txt);
        if (cleanLine && normTitleKey && (cleanLine === normTitleKey || normTitleKey.indexOf(cleanLine) !== -1 && cleanLine.length > 8)) {
          continue; // Evitar repetir título en continuación de página
        }
      }
      continuousLines.push(item);
    }
    if (p < pages.length - 1) {
      continuousLines.push(''); // Separación natural entre bloques
    }
  }

  const currentPageLines = continuousLines;
  const cols = tvState.wordCols || 2;
  const zoom = tvState.zoomScale || 1.0;

  const sheet = document.createElement('div');
  sheet.className = 'tv-word-sheet';
  sheet.style.fontSize = `${Math.round(18 * zoom)}px`;

  let html = `
    <div class="sheet-title-header">
      ${escapeHtml(song.artist)}: ${escapeHtml(song.title)}
      ${song.tone ? `<span style="font-size:0.8em; margin-left:12px; color:var(--tv-ruby);">[Tono: ${escapeHtml(song.tone)}]</span>` : ''}
    </div>
    <div class="tv-word-columns cols-${cols}">
  `;

  for (let i = 0; i < currentPageLines.length; i++) {
    const line = currentPageLines[i];
    const text = typeof line === 'string' ? line : (line.text || '');
    const trimmed = text.trim();

    if (!trimmed) {
      html += `<div class="word-line empty-line"></div>`;
      continue;
    }

    const isChord = (typeof line === 'object' && (line.lineType === 'chords' || line.red)) || isLikelyChordLine(text);
    const isHeader = (typeof line === 'object' && line.lineType === 'header') || /^(intro|coro|estribillo|solo|puente|verso|outro):?/i.test(trimmed);
    const isNote = (typeof line === 'object' && line.lineType === 'note') || /^\(.*\)$/.test(trimmed);

    let cls = 'word-line lyric-line';
    if (isChord) cls = 'word-line chord-line';
    else if (isHeader) cls = 'word-line header-line';
    else if (isNote) cls = 'word-line note-line';

    if (isChord && i + 1 < currentPageLines.length) {
      const nextLine = currentPageLines[i + 1];
      const nextText = typeof nextLine === 'string' ? nextLine : (nextLine.text || '');
      const nextIsChord = isLikelyChordLine(nextText);
      if (nextText.trim() && !nextIsChord) {
        html += `
          <div class="chord-lyric-group">
            <div class="word-line chord-line">${escapeHtml(text)}</div>
            <div class="word-line lyric-line">${escapeHtml(nextText)}</div>
          </div>
        `;
        i++;
        continue;
      }
    }

    html += `<div class="${cls}">${escapeHtml(text)}</div>`;
  }

  html += `</div>`;
  sheet.innerHTML = html;
  renderBox.appendChild(sheet);
}

function buildTvKaraokeData(song) {
  var useDbEntry = !(tvState.showingSpanish && song.spanishVersion && Array.isArray(song.spanishVersion.pages));
  var activeVid = tvState.currentVideoId || '';
  var dbEntry = null;
  if (useDbEntry) {
    if (activeVid && window.STANDALONE_KARAOKE_BY_VID && window.STANDALONE_KARAOKE_BY_VID[activeVid]) {
      dbEntry = window.STANDALONE_KARAOKE_BY_VID[activeVid];
    } else if (window.STANDALONE_KARAOKE) {
      dbEntry = window.STANDALONE_KARAOKE[song.karaokeLookupId || song.id] ||
                window.STANDALONE_KARAOKE[song.id] ||
                (song.playlistIndex ? window.STANDALONE_KARAOKE[String(song.playlistIndex)] : null) ||
                null;
    }
  }

  var rawDbLines = (dbEntry && (dbEntry.l || dbEntry.lines)) || null;
  if (dbEntry && Array.isArray(rawDbLines) && rawDbLines.length > 0) {
    return {
      sourceLabel: dbEntry.s ? ('Sincronizado (' + dbEntry.s + ')') : 'Sincronizado en vivo (Musixmatch/LRCLIB)',
      hasTimedSource: true,
      rawK: dbEntry
    };
  }

  // Fallback cronometrado manteniendo acordes, secciones y versos en orden exacto del documento
  var activePages = (tvState.showingSpanish && song.spanishVersion && Array.isArray(song.spanishVersion.pages) && song.spanishVersion.pages.length > 0)
    ? song.spanishVersion.pages
    : ((song.pages && song.pages.length > 0) ? song.pages : [(song.raw_lines || [])]);

  var docSeq = [];
  for (var p = 0; p < activePages.length; p++) {
    var lines = activePages[p] || [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var txt = (typeof l === 'string' ? l : (l && l.text ? l.text : '')).trim();
      if (!txt) continue;
      var isChord = (typeof l === 'object' && l && (l.lineType === 'chords' || l.red)) || isLikelyChordLine(txt);
      var isHeader = !isChord && ((typeof l === 'object' && l && l.lineType === 'header') || /^\[.*\]$/.test(txt));
      docSeq.push({ type: isChord ? 'chord' : (isHeader ? 'header' : 'lyrics'), text: txt });
    }
  }

  var estDuration = tvState.durationSec > 35 ? tvState.durationSec : 205;
  var startOffset = 6;
  var usableSpan = Math.max(40, estDuration - startOffset - 8);
  var lyricCount = 0;
  for (var c = 0; c < docSeq.length; c++) { if (docSeq[c].type === 'lyrics') lyricCount++; }
  var step = usableSpan / Math.max(1, lyricCount);

  var lyricIdx = 0;
  var lastEnd = startOffset;
  var fallbackTuples = [];
  for (var j = 0; j < docSeq.length; j++) {
    var item = docSeq[j];
    if (item.type === 'chord' || item.type === 'header') {
      var tVal = Math.max(0, +(lyricIdx < lyricCount ? (startOffset + lyricIdx * step) : lastEnd) - 0.1);
      fallbackTuples.push([+tVal.toFixed(1), +tVal.toFixed(1), item.type === 'chord' ? 1 : 2, item.text]);
    } else {
      var s = +(startOffset + lyricIdx * step).toFixed(2);
      var e = +(s + Math.max(2.2, step * 0.92)).toFixed(2);
      lastEnd = e;
      lyricIdx++;
      var words = item.text.split(/\s+/).filter(Boolean);
      var wDur = (e - s) / Math.max(1, words.length);
      var wStarts = words.map(function(_, wIdx) { return +(s + wIdx * wDur).toFixed(2); });
      fallbackTuples.push([s, e, 0, item.text, wStarts]);
    }
  }

  return {
    sourceLabel: 'Sincronización Rítmica Calibrada',
    hasTimedSource: false,
    rawK: fallbackTuples,
    baseDur: estDuration
  };
}

function renderTvKaraokeSheet(song, renderBox) {
  var kBuilt = buildTvKaraokeData(song);
  var zoom = tvState.zoomScale || 1.0;

  var pageNav = document.getElementById('tv-page-nav');
  if (pageNav) pageNav.style.display = 'none';
  var badgePages = document.getElementById('tv-badge-pages');
  if (badgePages) {
    badgePages.style.display = 'inline-block';
    badgePages.textContent = '🎤 Karaoke';
  }

  tvState.karaokeIsEstimated = !kBuilt.hasTimedSource || (kBuilt.sourceLabel && (kBuilt.sourceLabel.indexOf('Rítmica') !== -1 || kBuilt.sourceLabel.indexOf('Estim') !== -1));
  tvState.karaokeBaseDur = (kBuilt.rawK && kBuilt.rawK.d) ? Number(kBuilt.rawK.d) : (kBuilt.baseDur || 185);
  tvState.karaokeScaledToDur = false;

  var container = document.createElement('div');
  container.className = 'tv-karaoke-container';
  container.innerHTML =
    '<div class="tv-karaoke-header">' +
      '<div class="tv-karaoke-song-title">' + escapeHtml(song.artist) + ': ' + escapeHtml(song.title) + '</div>' +
      '<div class="tv-karaoke-song-sub">🎤 ' + escapeHtml(kBuilt.sourceLabel) + ' · Toca cualquier verso para saltar</div>' +
    '</div>' +
    '<div class="karaoke-lines-list tv-karaoke-lines-list" id="tv-k-list" style="font-size:' + Math.round(24 * zoom) + 'px;"></div>';

  renderBox.appendChild(container);

  if (!tvState.karaokeSyncCtrl && window.KaraokeSyncController) {
    tvState.karaokeSyncCtrl = new window.KaraokeSyncController({
      getCurrentTime: function() { return tvState.currentTimeSec || 0; },
      seekToTime: function(t) {
        seekTvAbsolute(t);
        if (!tvState.isPlaying) toggleTvPlayPause();
      },
      onSaveAnchors: function() {},
      onOffsetChanged: function() {}
    });
  }

  if (tvState.karaokeSyncCtrl) {
    var listEl = document.getElementById('tv-k-list');
    tvState.karaokeSyncCtrl.containerEl = listEl;
    tvState.karaokeSyncCtrl.getCurrentTime = function() { return tvState.currentTimeSec || 0; };
    tvState.karaokeSyncCtrl.seekToTime = function(t) {
      seekTvAbsolute(t);
      if (!tvState.isPlaying) toggleTvPlayPause();
    };
    tvState.karaokeSyncCtrl.onOffsetChanged = function() {};

    var sId = song.karaokeLookupId || song.id || String(song.playlistIndex || 'default');
    var vid = tvState.currentVideoId || 'default';
    tvState.karaokeSyncCtrl.loadSongData(kBuilt.rawK, sId, vid, kBuilt.hasTimedSource);
    tvState.karaokeSyncCtrl.updateActiveLine(tvState.currentTimeSec || 0, true);
  }
}

function cleanTvPdfMatch(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[\s\-_.,:;!?'"()\[\]{}–—\/\\#+*&%$@|~`^<>=]/g, '');
}

function resolveSongPdfPage(song, isEsp, pageOffset) {
  if (typeof isEsp === 'undefined') isEsp = false;
  if (typeof pageOffset === 'undefined') pageOffset = 0;
  if (!song) return { pdfFile: 'active_cancionero.pdf', pageNum: 1, basePage: 1, totalPages: 1 };

  var pdfFile = isEsp
    ? ((song.spanishVersion && song.spanishVersion.pdfFile) || 'faltantes.pdf')
    : (song.pdfFile || (song.book === 'reggaeton' ? 'reggaeton.pdf' : (song.book === 'faltantes' ? 'faltantes.pdf' : 'active_cancionero.pdf')));

  var basePage = isEsp
    ? ((song.spanishVersion && song.spanishVersion.pdfPage) || 1)
    : (song.pdfPage || (song.pdfPages && song.pdfPages[0]) || 1);

  // Verificación y calce exacto contra el índice extraído de los PDFs
  if (tvState.pdfIndex && tvState.pdfIndex[pdfFile]) {
    var bookIndex = tvState.pdfIndex[pdfFile];
    var targetTitle = isEsp ? ((song.spanishVersion && song.spanishVersion.title) || song.title) : song.title;
    var cleanTitle = cleanTvPdfMatch(targetTitle);

    var currentPageText = cleanTvPdfMatch(bookIndex[basePage] || '');
    var isDirectMatch = cleanTitle.length >= 3 && (currentPageText.indexOf(cleanTitle) !== -1 || (cleanTitle.length > 7 && currentPageText.indexOf(cleanTitle.slice(0, 8)) !== -1));

    if (!isDirectMatch && cleanTitle.length >= 3) {
      // 1. Probar páginas adyacentes (-1, +1, -2, +2, -3, +3)
      var found = null;
      var offsets = [-1, 1, -2, 2, -3, 3];
      for (var o = 0; o < offsets.length; o++) {
        var p = basePage + offsets[o];
        var pText = cleanTvPdfMatch(bookIndex[p] || '');
        if (pText.indexOf(cleanTitle) !== -1 || (cleanTitle.length > 7 && pText.indexOf(cleanTitle.slice(0, 8)) !== -1)) {
          found = p;
          break;
        }
      }

      // 2. Si no está en las adyacentes, búsqueda exhaustiva en el libro PDF
      if (found !== null) {
        basePage = found;
      } else {
        var pageKeys = Object.keys(bookIndex);
        for (var k = 0; k < pageKeys.length; k++) {
          var pStr = pageKeys[k];
          var fullText = cleanTvPdfMatch(bookIndex[pStr] || '');
          if (fullText.indexOf(cleanTitle) !== -1 || (cleanTitle.length > 8 && fullText.indexOf(cleanTitle.slice(0, 9)) !== -1)) {
            basePage = parseInt(pStr, 10);
            break;
          }
        }
      }
    }
  }

  var finalPage = Math.max(1, basePage + pageOffset);
  var totalPages = (song.pdfPages && song.pdfPages.length > 0)
    ? song.pdfPages.length
    : (song.totalPages || 1);

  return { pdfFile: pdfFile, pageNum: finalPage, basePage: basePage, totalPages: totalPages };
}

function navigateTvPage(delta) {
  // Paginación exclusiva del modo PDF (en Word la vista siempre es continua)
  if (tvState.viewMode === 'pdf') {
    tvState.pdfPageOffset += delta;
    if (tvState.currentSong) {
      const renderBox = document.getElementById('tv-sheet-render-box');
      if (renderBox) renderTvPdfSheet(tvState.currentSong, renderBox);
    }
  }
}

function loadPdfDocumentSafe(pdfFile) {
  if (tvState.pdfDocs[pdfFile]) {
    return Promise.resolve(tvState.pdfDocs[pdfFile]);
  }
  try {
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
    }
  } catch (e) {}

  var opts = {
    url: pdfFile,
    disableAutoFetch: true,
    disableStream: false,
    cMapPacked: true
  };

  return pdfjsLib.getDocument(opts).promise.then(function(doc) {
    tvState.pdfDocs[pdfFile] = doc;
    return doc;
  }).catch(function(err) {
    console.warn('[PDF] Reintentando carga sin Web Worker para compatibilidad Smart TV:', err && err.message);
    return pdfjsLib.getDocument({
      url: pdfFile,
      disableWorker: true,
      disableAutoFetch: true
    }).promise.then(function(doc) {
      tvState.pdfDocs[pdfFile] = doc;
      return doc;
    });
  });
}

async function renderTvPdfSheet(song, renderBox) {
  if (typeof pdfjsLib === 'undefined') {
    renderBox.innerHTML = '<div style="padding:40px; color:#f87171; text-align:center;">Librería PDF.js no disponible. Recarga la página.</div>';
    return;
  }

  // Cancelar renderizado en curso para evitar superposiciones y condiciones de carrera
  if (tvState.currentPdfRenderTask) {
    try {
      tvState.currentPdfRenderTask.cancel();
    } catch (e) {}
    tvState.currentPdfRenderTask = null;
  }

  var thisSeq = ++tvState.pdfRenderSeq;
  var isEsp = !!(tvState.showingSpanish && song.spanishVersion);
  var resolved = resolveSongPdfPage(song, isEsp, tvState.pdfPageOffset);
  var pdfFile = resolved.pdfFile;
  var pageNum = resolved.pageNum;
  var totalPages = resolved.totalPages;

  // Barra de navegación de páginas en modo PDF (activa y sincronizada)
  var pageNav = document.getElementById('tv-page-nav');
  var indicator = document.getElementById('tv-page-indicator');
  if (pageNav) {
    pageNav.style.display = 'flex';
  }
  if (indicator) {
    var leafText = totalPages > 1 ? (' · Hoja ' + Math.min(totalPages, Math.max(1, tvState.pdfPageOffset + 1)) + ' de ' + totalPages) : '';
    indicator.textContent = 'Pág. ' + pageNum + leafText;
  }

  renderBox.innerHTML = '<div style="padding:40px; color:#38bdf8; text-align:center; font-size:18px; font-weight:700;">📄 Cargando página ' + pageNum + ' de ' + escapeHtml(pdfFile) + '...</div>';

  try {
    var pdfDoc = await loadPdfDocumentSafe(pdfFile);
    if (thisSeq !== tvState.pdfRenderSeq) return; // Petición obsoleta

    var safePageNum = Math.min(pdfDoc.numPages, Math.max(1, pageNum));
    var page = await pdfDoc.getPage(safePageNum);
    if (thisSeq !== tvState.pdfRenderSeq) return; // Petición obsoleta

    renderBox.innerHTML = '';

    var canvas = document.createElement('canvas');
    canvas.className = 'tv-pdf-canvas';
    renderBox.appendChild(canvas);

    // Ajuste inteligente al ancho disponible para que el PDF nunca salga cortado y no supere el límite de memoria en Smart TV
    var baseViewport = page.getViewport({ scale: 1.0 });
    var availableWidth = Math.max(320, (renderBox.clientWidth || 860) - 24);
    var fitScale = availableWidth / baseViewport.width;
    var zoom = tvState.zoomScale || 1.0;
    var dpr = Math.min(window.devicePixelRatio || 1.5, 2.0);
    var targetScale = fitScale * zoom * dpr;

    // Límite seguro de textura en televisores (máximo 2400px de ancho)
    if (baseViewport.width * targetScale > 2400) {
      targetScale = 2400 / baseViewport.width;
    }

    var viewport = page.getViewport({ scale: targetScale });
    var cssWidth = Math.round(baseViewport.width * fitScale * zoom);

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = cssWidth + 'px';
    canvas.style.maxWidth = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.borderRadius = '12px';
    canvas.style.background = '#ffffff';
    canvas.style.boxShadow = '0 0 30px rgba(0,0,0,0.9)';

    var ctx = canvas.getContext('2d');
    tvState.currentPdfRenderTask = page.render({ canvasContext: ctx, viewport: viewport });
    await tvState.currentPdfRenderTask.promise;
    tvState.currentPdfRenderTask = null;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') {
      return; // Cancelación normal al cambiar rápido de página
    }
    renderBox.innerHTML = '<div style="padding:40px; color:#f87171; text-align:center;">Error cargando PDF (Pág. ' + pageNum + '): ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
  }
}

// ==============================================================
// 6. GESTIÓN UNIVERSAL DEL CONTROL REMOTO SMART TV (D-PAD & KEYCODES)
// Compatible con LG webOS, Samsung Tizen, Android TV, Sony, Hisense, VIDAA y PC
// ==============================================================
function initTvRemoteNavigation() {
  // Registrar teclas en Samsung Tizen Smart TVs si está disponible la API nativa
  if (window.tizen && window.tizen.tvinputdevice) {
    try {
      var tizenKeys = [
        'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
        'MediaFastForward', 'MediaRewind',
        'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
        'ChannelUp', 'ChannelDown'
      ];
      for (var k = 0; k < tizenKeys.length; k++) {
        try { window.tizen.tvinputdevice.registerKey(tizenKeys[k]); } catch (tkErr) {}
      }
    } catch (tizenErr) {}
  }

  window.addEventListener('keydown', function(e) {
    var code = e.keyCode || e.which || 0;
    var key = e.key || '';

    // Si la pantalla está apagada (modo blackout), cualquier tecla la despierta
    var blackoutEl = document.getElementById('tv-oled-blackout');
    if (blackoutEl && blackoutEl.style.display !== 'none') {
      e.preventDefault();
      toggleTvOledBlackout(false);
      return;
    }

    // Si el usuario está escribiendo en el buscador, permitir teclas normales excepto Escape / Return
    if (e.target && e.target.tagName === 'INPUT') {
      if (key === 'Escape' || code === 27 || code === 10009 || code === 461 || code === 4) {
        e.target.blur();
        var songList = document.getElementById('tv-song-list');
        if (songList) {
          var activeSong = songList.querySelector('.tv-song-item.active') || songList.querySelector('.tv-song-item');
          if (activeSong) activeSong.focus();
        }
      }
      return;
    }

    // 1. Botón Volver / Return / Back (Samsung Tizen: 10009, webOS: 461, Android: 4, Escape: 27)
    if (code === 10009 || code === 461 || code === 27 || code === 4 || key === 'Escape') {
      e.preventDefault();
      var modal = document.getElementById('tv-remote-modal');
      if (modal && modal.style.display === 'flex') {
        modal.style.display = 'none';
        return;
      }
      if (!tvState.sidebarVisible) {
        toggleTvSidebar();
        return;
      }
      var activeItem = document.querySelector('.tv-song-item.active');
      if (activeItem) {
        activeItem.focus();
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }

    // 2. Play / Pausa (Universal: Tecla Espacio, Control Media Play/Pause, Tizen 415/19/10252, webOS, Android 179)
    if (code === 32 || code === 179 || code === 415 || code === 19 || code === 10252 || key === ' ' || key === 'MediaPlayPause') {
      if (code === 32 && e.target && (e.target.tagName === 'BUTTON' || (e.target.classList && e.target.classList.contains('tv-btn')))) {
        return;
      }
      e.preventDefault();
      toggleTvPlayPause();
      showTvToast(tvState.isPlaying ? '▶ Reproduciendo' : '⏸ En Pausa', 1500);
      return;
    }

    // 3. Botones de Colores de Mandos de Televisor
    // Rojo (403): Repertorio / Menú Lateral
    if (code === 403 || key === 'ColorF0Red') {
      e.preventDefault();
      toggleTvSidebar();
      return;
    }
    // Verde (404): Conmutar Modo (Word -> PDF -> Karaoke)
    if (code === 404 || key === 'ColorF1Green') {
      e.preventDefault();
      var modes = ['word', 'pdf', 'karaoke'];
      var curIdx = modes.indexOf(tvState.viewMode);
      var nextMode = modes[(curIdx + 1) % modes.length];
      setTvViewMode(nextMode);
      return;
    }
    // Amarillo (405): Conmutar Portada HD / Video YouTube
    if (code === 405 || key === 'ColorF2Yellow') {
      e.preventDefault();
      var nextStage = tvState.stageMode === 'poster' ? 'video' : 'poster';
      setTvStageMode(nextStage);
      showTvToast(nextStage === 'video' ? '🎬 Reproductor YouTube' : '📻 Portada Neón', 1500);
      return;
    }
    // Azul (406): Apagar Pantalla (True Black 0 Nits)
    if (code === 406 || key === 'ColorF3Blue' || key === 'b' || key === 'B') {
      e.preventDefault();
      toggleTvOledBlackout();
      return;
    }

    // 4. Avance / Retroceso de Audio (Rewind 412, FastForward 417)
    if (code === 412) {
      e.preventDefault();
      seekTvRelative(-10);
      return;
    }
    if (code === 417) {
      e.preventDefault();
      seekTvRelative(10);
      return;
    }

    // 5. Cambio de Hoja / Página (ChannelUp 427/33, ChannelDown 428/34, PageUp, PageDown)
    if (code === 33 || code === 427 || key === 'PageUp' || key === '[') {
      e.preventDefault();
      navigateTvPage(-1);
      return;
    }
    if (code === 34 || code === 428 || key === 'PageDown' || key === ']') {
      e.preventDefault();
      navigateTvPage(1);
      return;
    }

    // 6. Navegación Inteligente con D-Pad (Flechas Arriba / Abajo / Izquierda / Derecha)
    // Arriba (38 / ArrowUp)
    if (code === 38 || key === 'ArrowUp') {
      var focusedSong = document.activeElement && document.activeElement.closest('.tv-song-item');
      if (focusedSong) {
        e.preventDefault();
        var prevSong = focusedSong.previousElementSibling;
        if (prevSong && prevSong.classList.contains('tv-song-item')) {
          prevSong.focus();
          prevSong.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
          var searchInp = document.getElementById('tv-search-input');
          if (searchInp) searchInp.focus();
        }
        return;
      }
      e.preventDefault();
      scrollTvSheet(-120);
      return;
    }

    // Abajo (40 / ArrowDown)
    if (code === 40 || key === 'ArrowDown') {
      var focusedSongDown = document.activeElement && document.activeElement.closest('.tv-song-item');
      if (focusedSongDown) {
        e.preventDefault();
        var nextSong = focusedSongDown.nextElementSibling;
        if (nextSong && nextSong.classList.contains('tv-song-item')) {
          nextSong.focus();
          nextSong.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return;
      }
      if (!document.activeElement || document.activeElement === document.body) {
        var activeSongItem = document.querySelector('.tv-song-item.active') || document.querySelector('.tv-song-item');
        if (activeSongItem) {
          e.preventDefault();
          activeSongItem.focus();
          activeSongItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          return;
        }
      }
      e.preventDefault();
      scrollTvSheet(120);
      return;
    }

    // Izquierda (37 / ArrowLeft)
    if (code === 37 || key === 'ArrowLeft') {
      if (e.ctrlKey || e.altKey) {
        seekTvRelative(-10);
        return;
      }
      var scroller = document.getElementById('tv-sheet-scroller');
      var stage = document.getElementById('tv-stage-box');
      if (document.activeElement && ((scroller && scroller.contains(document.activeElement)) || (stage && stage.contains(document.activeElement)))) {
        e.preventDefault();
        var actSong = document.querySelector('.tv-song-item.active') || document.querySelector('.tv-song-item');
        if (actSong) {
          actSong.focus();
          actSong.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return;
      }
      e.preventDefault();
      navigateTvSong(-1);
      return;
    }

    // Derecha (39 / ArrowRight)
    if (code === 39 || key === 'ArrowRight') {
      if (e.ctrlKey || e.altKey) {
        seekTvRelative(10);
        return;
      }
      var inSongList = document.activeElement && document.activeElement.closest('#tv-song-list');
      if (inSongList) {
        e.preventDefault();
        var playBtn = document.getElementById('btn-tv-play-pause');
        if (playBtn) playBtn.focus();
        return;
      }
      e.preventDefault();
      navigateTvSong(1);
      return;
    }

    // Atajos de teclado directo en PC / Mando numérico
    if (key === '1') setTvViewMode('pdf');
    else if (key === '2') setTvViewMode('word');
    else if (key === '3') setTvViewMode('karaoke');
    else if (key === 's' || key === 'S') { e.preventDefault(); toggleTvShuffle(); }
    else if (key === 'r' || key === 'R') { e.preventDefault(); toggleTvRepeat(); }
    else if (key === 'l' || key === 'L') { e.preventDefault(); setTvSongLanguage(!tvState.showingSpanish); }
    else if (key === 't' || key === 'T') {
      e.preventDefault();
      if (window.ScoreSplitManager && typeof window.ScoreSplitManager.toggle === 'function') {
        window.ScoreSplitManager.toggle();
      }
    }
    else if (key === 'm' || key === 'M') { e.preventDefault(); toggleTvSidebar(); }
    else if (key === 'f' || key === 'F') { e.preventDefault(); toggleTvFullscreen(); }
    else if (key === 'o' || key === 'O') { e.preventDefault(); toggleTvTheme(); }
    else if (key === 'c' || key === 'C') { e.preventDefault(); cycleTvCols(); }
  });
}

function scrollTvSheet(delta) {
  const scroller = document.getElementById('tv-sheet-scroller');
  if (scroller) {
    scroller.scrollBy({ top: delta, behavior: 'smooth' });
  }
}

function toggleTvSidebar() {
  tvState.sidebarVisible = !tvState.sidebarVisible;
  document.body.classList.toggle('sidebar-collapsed', !tvState.sidebarVisible);
  showTvToast(tvState.sidebarVisible ? 'Menú lateral visible' : 'Menú lateral oculto (Pantalla amplia)', 1800);
}

function toggleTvFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    showTvToast('⛶ Pantalla completa activada', 1800);
  } else {
    document.exitFullscreen().catch(() => {});
    showTvToast('Ventana estándar', 1800);
  }
}

function toggleTvTheme() {
  tvState.theme = tvState.theme === 'oled' ? 'white' : 'oled';
  document.body.classList.toggle('theme-oled-dark', tvState.theme === 'oled');
  document.body.classList.toggle('theme-paper-white', tvState.theme === 'white');

  const iconEl = document.getElementById('theme-icon');
  const labelEl = document.getElementById('theme-label');
  if (iconEl) iconEl.textContent = tvState.theme === 'oled' ? '🌙' : '☀️';
  if (labelEl) labelEl.textContent = tvState.theme === 'oled' ? 'OLED Cine' : 'Papel Blanco';

  showTvToast(tvState.theme === 'oled' ? '🌙 Modo OLED Cine (Negro Puro #000000)' : '☀️ Modo Papel Blanco', 2000);
  renderCurrentTvSheet();
}

function setTvViewMode(mode) {
  tvState.viewMode = mode;
  if (typeof tvTouchActivity === 'function') tvTouchActivity();
  ['tv-mode-pdf', 'tv-mode-word', 'tv-mode-karaoke'].forEach(function(id) {
    var b = document.getElementById(id);
    if (b) b.classList.remove('active');
  });
  const activeBtn = document.getElementById(`tv-mode-${mode}`);
  if (activeBtn) activeBtn.classList.add('active');

  showTvToast(`Visualizando en modo ${mode.toUpperCase()}`, 1500);
  renderCurrentTvSheet();
}

function cycleTvCols() {
  if (tvState.viewMode !== 'word') return;
  let nextCols = tvState.wordCols + 1;
  if (nextCols > 4) nextCols = 1;
  setTvCols(nextCols);
}

function setTvCols(cols) {
  tvState.wordCols = cols;
  document.querySelectorAll('.tv-col-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.cols, 10) === cols);
  });
  showTvToast(`Formato: ${cols} Columna${cols > 1 ? 's' : ''}`, 1500);
  renderCurrentTvSheet();
}

function showTvToast(message, duration = 2000) {
  const container = document.getElementById('tv-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'tv-toast';
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 280);
  }, duration);
}

// ==============================================================
// 7. INICIALIZACIÓN DE LA APLICACIÓN TV
// ==============================================================
function initTvApp() {
  // 1. Inicializar Motor de Audio Nativo
  initTvAudioEngine();

  // Cargar índice inteligente de páginas PDF para calce 100% exacto
  fetch('pdf_pages_index.json')
    .then(res => res.json())
    .then(data => {
      tvState.pdfIndex = data;
      console.log('[PDF Index] Índice maestro de páginas cargado.');
    })
    .catch(err => {
      console.warn('[PDF Index] No se pudo cargar el índice de páginas PDF:', err.message);
    });

  // 2. Cargar Marcas (Favoritas / Reportes) y Canciones
  loadTvSongMarks();
  tvState.songs = buildTvSongs(tvState.activeBook);
  populateArtistFilter();
  filterTvSongs();

  // 3. Listeners de Botones Superiores
  on('btn-toggle-sidebar', 'click', toggleTvSidebar);
  on('btn-toggle-theme', 'click', toggleTvTheme);
  on('btn-fullscreen-tv', 'click', toggleTvFullscreen);

  function toggleTvPlayerPanel() {
    tvState.layout = tvState.layout === 'split' ? 'solo' : 'split';
    document.body.classList.toggle('layout-split', tvState.layout === 'split');
    document.body.classList.toggle('layout-solo', tvState.layout === 'solo');
    var btn = document.getElementById('btn-toggle-layout');
    if (btn) btn.classList.toggle('active', tvState.layout === 'split');
    var label = document.getElementById('layout-label');
    if (label) label.textContent = 'Reproducción / Acordes';
    showTvToast(tvState.layout === 'split' ? '🎸 Panel de Reproducción y Acordes visible' : '⛶ Panel de Reproducción y Acordes oculto (música activa)', 1800);
  }

  on('btn-toggle-layout', 'click', toggleTvPlayerPanel);
  on('btn-collapse-video', 'click', toggleTvPlayerPanel);

  // Alternador de Video YouTube / Portada
  on('btn-toggle-video-mode', 'click', () => {
    const nextMode = tvState.stageMode === 'poster' ? 'video' : 'poster';
    setTvStageMode(nextMode);
    showTvToast(nextMode === 'video' ? '🎬 Activando reproductor YouTube' : '📻 Modo Audio Alta Fidelidad con Portada', 1800);
  });

  // Selector de Modos (PDF | Word | Karaoke)
  on('tv-mode-pdf', 'click', () => setTvViewMode('pdf'));
  on('tv-mode-word', 'click', () => setTvViewMode('word'));
  on('tv-mode-karaoke', 'click', () => setTvViewMode('karaoke'));

  // Selector de Columnas
  document.querySelectorAll('.tv-col-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTvCols(parseInt(btn.dataset.cols, 10));
    });
  });

  // Zoom
  on('btn-zoom-in', 'click', () => {
    tvState.zoomScale = Math.min(2.5, Math.round((tvState.zoomScale + 0.1) * 10) / 10);
    document.getElementById('tv-zoom-badge').textContent = `${Math.round(tvState.zoomScale * 100)}%`;
    renderCurrentTvSheet();
  });

  on('btn-zoom-out', 'click', () => {
    tvState.zoomScale = Math.max(0.6, Math.round((tvState.zoomScale - 0.1) * 10) / 10);
    document.getElementById('tv-zoom-badge').textContent = `${Math.round(tvState.zoomScale * 100)}%`;
    renderCurrentTvSheet();
  });

  // Selector segmentado de idioma (Original / Español)
  on('btn-tv-lang-orig', 'click', function() { setTvSongLanguage(false); });
  on('btn-tv-lang-es', 'click', function() { setTvSongLanguage(true); });

  // Switcher de Repertorio (Todos | Principal | Reggaetón)
  const bookBtns = [
    { id: 'tv-book-all', book: 'all' },
    { id: 'tv-book-principal', book: 'principal' },
    { id: 'tv-book-reggaeton', book: 'reggaeton' },
    { id: 'tv-book-faltantes', book: 'faltantes' }
  ];

  bookBtns.forEach(item => {
    on(item.id, 'click', () => {
      tvState.activeBook = item.book;
      tvState.shuffleQueue = [];
      document.querySelectorAll('.tv-book-btn').forEach(b => b.classList.remove('active'));
      var actEl = document.getElementById(item.id); if (actEl) actEl.classList.add('active');
      tvState.songs = buildTvSongs(item.book);
      populateArtistFilter();
      filterTvSongs();
      if (tvState.filteredSongs.length > 0) {
        selectTvSong(tvState.filteredSongs[0].id, false);
      }
    });
  });

  // Cambio manual de versión de YouTube
  on('tv-versions-select', 'change', (e) => {
    var newVid = extractVideoId(e.target.value);
    if (newVid) {
      tvState.currentVideoId = newVid;
      loadYouTubeVideoInPlayer(newVid, true);
      updateTvPosterOverlay(tvState.currentSong, newVid);
      var openYtBtn = document.getElementById('btn-tv-open-yt');
      if (openYtBtn) openYtBtn.href = 'https://www.youtube.com/watch?v=' + newVid;
      if (tvState.viewMode === 'karaoke') renderCurrentTvSheet();
      showTvToast('🎬 Cambiando a versión seleccionada...', 1500);
    }
  });

  // Buscador y Filtros
  const searchInput = document.getElementById('tv-search-input');
  const clearBtn = document.getElementById('btn-tv-clear-search');
  if (searchInput) searchInput.addEventListener('input', (e) => {
    tvState.searchQuery = e.target.value;
    if (clearBtn) clearBtn.style.display = tvState.searchQuery ? 'block' : 'none';
    filterTvSongs();
  });

  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    tvState.searchQuery = '';
    clearBtn.style.display = 'none';
    filterTvSongs();
  });

  on('tv-artist-select', 'change', (e) => {
    tvState.selectedArtist = e.target.value;
    filterTvSongs();
  });

  document.querySelectorAll('.tv-filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tv-filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      tvState.currentFilter = tab.dataset.filter;
      filterTvSongs();
    });
  });

  // Botones de marca de la canción actual: Favorita / Acorde ✗ / Letra ✗ / Sincro ✗
  on('btn-tv-mark-fav', 'click', function(e) { e.stopPropagation(); toggleTvSongMark('fav'); });
  on('btn-tv-mark-bad-chord', 'click', function(e) { e.stopPropagation(); toggleTvSongMark('badChord'); });
  on('btn-tv-mark-bad-lyric', 'click', function(e) { e.stopPropagation(); toggleTvSongMark('badLyric'); });
  on('btn-tv-mark-bad-sync', 'click', function(e) { e.stopPropagation(); toggleTvSongMark('badSync'); });

  // Botón e interfaz de Compartir Informe (sin edición, solo registro de marcas/fallas)
  initTvShareMarksModal();

  // Filtros de Favoritas y Reportes de error
  document.querySelectorAll('.tv-mark-filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tv-mark-filter-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      tvState.markFilter = btn.getAttribute('data-mark-filter') || 'all';
      tvState.shuffleQueue = [];
      filterTvSongs();
    });
  });

  // Controles de Reproducción TV
  on('btn-tv-play-pause', 'click', toggleTvPlayPause);
  on('btn-tv-prev-song', 'click', () => navigateTvSong(-1));
  on('btn-tv-next-song', 'click', () => navigateTvSong(1));
  on('btn-tv-rew-10', 'click', () => seekTvRelative(-10));
  on('btn-tv-rew-5', 'click', () => seekTvRelative(-5));
  on('btn-tv-fwd-5', 'click', () => seekTvRelative(5));
  on('btn-tv-fwd-10', 'click', () => seekTvRelative(10));
  on('btn-tv-shuffle', 'click', toggleTvShuffle);
  on('btn-tv-repeat', 'click', toggleTvRepeat);

  // Slider de Avance
  const seekSlider = document.getElementById('tv-seek-slider');
  if (seekSlider) seekSlider.addEventListener('input', (e) => {
    if (tvState.durationSec > 0) {
      const targetSec = (parseInt(e.target.value, 10) / 1000) * tvState.durationSec;
      seekTvAbsolute(targetSec);
    }
  });

  // Paginador Universal (Word y PDF con calce dinámico)
  on('btn-tv-prev-page', 'click', () => {
    navigateTvPage(-1);
  });

  on('btn-tv-next-page', 'click', () => {
    navigateTvPage(1);
  });

  // Inicializar marcos redimensionables para Lista de Canciones y Reproducción/Acordes
  initTvPanelResizers();

  // Puentes globales e inicialización del Motor de Tabs / Partitura Horizontal (ScoreSplitManager)
  window.state = tvState;
  window.showToast = function(msg, type, dur) { showTvToast(msg, dur || 2000); };
  window.seekToSeconds = function(sec) { seekTvAbsolute(sec); };
  window.getSmoothAudioTimeSec = function() {
    if (tvState.isPlaying && tvState.ytClockPerfMs > 0) {
      var nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var delta = (nowMs - tvState.ytClockPerfMs) / 1000;
      if (delta >= 0 && delta <= 1.2) {
        return Math.max(0, (tvState.currentTimeSec || 0) + delta);
      }
    }
    return Math.max(0, tvState.currentTimeSec || 0);
  };
  if (window.ScoreSplitManager && typeof window.ScoreSplitManager.init === 'function') {
    try { window.ScoreSplitManager.init(); } catch (eScInit) {}
  }

  // Modal de Ayuda Magic Remote
  const remoteModal = document.getElementById('tv-remote-modal');
  on('btn-remote-help', 'click', () => {
    if (remoteModal) remoteModal.style.display = 'flex';
  });
  on('btn-close-remote-modal', 'click', () => {
    if (remoteModal) remoteModal.style.display = 'none';
  });

  // Iniciar Navegación por Control Remoto & Teclado
  initTvRemoteNavigation();

  // Iniciar Suite de Protección OLED LG C4 (Pixel Orbiter + Atenuador de Inactividad + Ocultamiento Dinámico)
  initTvOledProtection();

  // Clic en la pantalla apagada para despertar de inmediato
  on('tv-oled-blackout', 'click', () => {
    toggleTvOledBlackout(false);
  });

  // Seleccionar la primera canción por defecto (sin forzar autoplay inmediato en carga)
  if (tvState.songs.length > 0) {
    selectTvSong(tvState.songs[0].id, false);
  }
}

// ==============================================================
// 7. SUITE DE PROTECCIÓN OLED LG C4 (ANTI-BURN IN & CAREFREE)
// ==============================================================
var oledOrbiterInterval = null;
var oledInactivityTimer = null;
var oledHeaderHideTimer = null;
var OLED_INACTIVITY_MS = 120000; // 2 minutos para activar atenuación profunda
var OLED_HEADER_AUTOHIDE_MS = 6000; // 6 segundos de reproducción para ocultar barra fija

var tvWakeLockSentinel = null;
var tvNoSleepInstance = null;
var tvNoSleepEnabled = false;
var tvKeepAwakeVideoEl = null;
var tvLastActivityTs = Date.now();
var tvStaticGuardInterval = null;
var OLED_STATIC_SUSPEND_MS = 10 * 60 * 1000; // 10 minutos con pantalla totalmente estática (nunca en Karaoke)

function initTvKeepAwakeVideo() {
  if (tvKeepAwakeVideoEl) return tvKeepAwakeVideoEl;
  var vid = document.getElementById('tv-keepawake-video');
  if (!vid) return null;
  vid.muted = true;
  vid.loop = true;
  vid.setAttribute('muted', '');
  vid.setAttribute('playsinline', '');
  vid.setAttribute('loop', '');
  if (!vid.src && window.TV_KEEPAWAKE_MP4) {
    vid.src = window.TV_KEEPAWAKE_MP4;
  }
  tvKeepAwakeVideoEl = vid;
  return vid;
}

function tvTouchActivity() {
  tvLastActivityTs = Date.now();
  // Si estaba en suspensión OLED protectora, despertar al instante
  var blackoutEl = document.getElementById('tv-oled-blackout');
  if (blackoutEl && blackoutEl.style.display !== 'none') {
    toggleTvOledBlackout(false);
  }
  ensureTvAwake();
}

function ensureTvAwake() {
  if (document.visibilityState !== 'visible') return;

  // CAPA 1 (PRINCIPAL PARA LG webOS / SAMSUNG TIZEN):
  // Reproducir el video H.264 silencioso de 2x2px montado DENTRO del viewport visible.
  // El compositor del televisor detecta decodificación de video activa en pantalla y bloquea el protector/suspensión del SO.
  try {
    var vid = initTvKeepAwakeVideo();
    if (vid && vid.src && vid.paused) {
      var pVid = vid.play();
      if (pVid && typeof pVid.catch === 'function') {
        pVid.catch(function() {});
      }
    }
  } catch (e) {}

  // CAPA 2: Screen Wake Lock API nativa
  try {
    if (navigator.wakeLock && navigator.wakeLock.request && !tvWakeLockSentinel) {
      navigator.wakeLock.request('screen').then(function(sentinel) {
        tvWakeLockSentinel = sentinel;
        sentinel.addEventListener('release', function() {
          tvWakeLockSentinel = null;
        });
      }).catch(function() {});
    }
  } catch (e) {}

  // CAPA 3: NoSleep.js (manejando su Promise correctamente para reintentar si faltó gesto previo)
  try {
    if (typeof window.NoSleep === 'function' && !tvNoSleepEnabled) {
      if (!tvNoSleepInstance) tvNoSleepInstance = new window.NoSleep();
      var pNs = tvNoSleepInstance.enable();
      if (pNs && typeof pNs.then === 'function') {
        pNs.then(function() { tvNoSleepEnabled = true; }).catch(function() { tvNoSleepEnabled = false; });
      } else {
        tvNoSleepEnabled = true;
      }
    }
  } catch (e) {
    tvNoSleepEnabled = false;
  }
}

function releaseTvAwake() {
  try {
    if (tvKeepAwakeVideoEl && !tvKeepAwakeVideoEl.paused) {
      tvKeepAwakeVideoEl.pause();
    }
  } catch (e) {}
  try {
    if (tvWakeLockSentinel) {
      tvWakeLockSentinel.release().catch(function() {});
      tvWakeLockSentinel = null;
    }
  } catch (e) {}
  try {
    if (tvNoSleepInstance && tvNoSleepEnabled) {
      tvNoSleepInstance.disable();
      tvNoSleepEnabled = false;
    }
  } catch (e) {}
}

function checkTvOledStaticSuspension() {
  // Regla estricta:
  // 1) En modo Karaoke (o con Tabs en movimiento durante reproducción) NUNCA suspender.
  // 2) Mientras la app está funcionando activamente (reproduciendo o con uso reciente), mantener la TV siempre despierta.
  // 3) Solo activar protección OLED si el contenido queda estático en el mismo lugar > 10 minutos (Word/PDF/pausa sin cambios).
  var tabsMoving = !!(window.ScoreSplitManager && window.ScoreSplitManager.isPanelOpen && tvState.isPlaying);
  if (tvState.viewMode === 'karaoke' || tabsMoving) {
    tvLastActivityTs = Date.now();
    ensureTvAwake();
    return;
  }

  var blackoutEl = document.getElementById('tv-oled-blackout');
  var alreadyBlackout = blackoutEl && blackoutEl.style.display !== 'none';
  if (alreadyBlackout) return;

  var idleMs = Date.now() - tvLastActivityTs;
  if (idleMs >= OLED_STATIC_SUSPEND_MS) {
    // Contenido estático prolongado en el mismo lugar -> proteger panel OLED sin cortar la música
    toggleTvOledBlackout(true);
    if (!tvState.isPlaying) {
      releaseTvAwake();
    }
  } else {
    ensureTvAwake();
  }
}

function initTvOledProtection() {
  startPixelOrbiter();
  resetInactivityTimer();
  initTvKeepAwakeVideo();
  tvLastActivityTs = Date.now();

  // Intentar activar anti-suspensión al cargar y al volver a la pestaña
  ensureTvAwake();
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      tvTouchActivity();
    }
  });

  // Gestos reales del usuario desbloquean siempre el video H.264 anti-suspensión y WakeLock en cualquier TV
  var activationEvents = ['click', 'keydown', 'touchstart', 'pointerdown', 'mousedown'];
  for (var a = 0; a < activationEvents.length; a++) {
    window.addEventListener(activationEvents[a], function() {
      ensureTvAwake();
    }, { passive: true });
  }

  // Detectar actividad de usuario para mantener despierta la TV y mostrar barra superior
  var activityEvents = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown', 'click'];
  for (var i = 0; i < activityEvents.length; i++) {
    window.addEventListener(activityEvents[i], function() {
      if (document.body.classList.contains('oled-dimmed')) {
        document.body.classList.remove('oled-dimmed');
      }
      tvLastActivityTs = Date.now();
      ensureTvAwake();
      resetInactivityTimer();

      // Al mover el control o pulsar teclas, mostrar barra superior temporalmente
      showHeaderBar();
      if (tvState.isPlaying) {
        scheduleHeaderAutoHide();
      }
    }, { passive: true });
  }

  // Monitor cada 10s para verificar que el video anti-suspensión siga corriendo + protección solo ante estática real
  if (tvStaticGuardInterval) clearInterval(tvStaticGuardInterval);
  tvStaticGuardInterval = setInterval(checkTvOledStaticSuspension, 10000);

  // Despertar de blackout al mover el puntero
  var blackoutEl = document.getElementById('tv-oled-blackout');
  if (blackoutEl) {
    var lastMoveTime = 0;
    blackoutEl.addEventListener('mousemove', function() {
      var now = Date.now();
      if (now - lastMoveTime > 300) {
        lastMoveTime = now;
        toggleTvOledBlackout(false);
        tvTouchActivity();
      }
    });
  }
}

function scheduleHeaderAutoHide() {
  if (oledHeaderHideTimer) clearTimeout(oledHeaderHideTimer);
  oledHeaderHideTimer = setTimeout(function() {
    if (tvState.isPlaying) {
      document.body.classList.add('tv-header-hidden');
    }
  }, OLED_HEADER_AUTOHIDE_MS);
}

function showHeaderBar() {
  if (oledHeaderHideTimer) clearTimeout(oledHeaderHideTimer);
  document.body.classList.remove('tv-header-hidden');
}

function initTvPanelResizers() {
  var root = document.documentElement;
  var leftResizer = document.getElementById('tv-resizer-left');
  var rightResizer = document.getElementById('tv-resizer-right');

  var DEFAULT_LEFT = 360;
  var DEFAULT_RIGHT = 440;
  var MIN_LEFT = 220, MAX_LEFT = 620;
  var MIN_RIGHT = 280, MAX_RIGHT = 720;

  function applyLeftWidth(px, persist) {
    var val = Math.max(MIN_LEFT, Math.min(MAX_LEFT, Math.round(px)));
    root.style.setProperty('--tv-sidebar-width', val + 'px');
    if (persist) {
      try { localStorage.setItem('tv_sidebar_width', String(val)); } catch (e) {}
    }
    return val;
  }

  function applyRightWidth(px, persist) {
    var val = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, Math.round(px)));
    root.style.setProperty('--tv-player-width', val + 'px');
    if (persist) {
      try { localStorage.setItem('tv_player_width', String(val)); } catch (e) {}
    }
    return val;
  }

  // Restaurar anchos guardados por el usuario
  try {
    var savedL = parseInt(localStorage.getItem('tv_sidebar_width') || '', 10);
    if (!isNaN(savedL) && savedL >= MIN_LEFT && savedL <= MAX_LEFT) applyLeftWidth(savedL, false);
    var savedR = parseInt(localStorage.getItem('tv_player_width') || '', 10);
    if (!isNaN(savedR) && savedR >= MIN_RIGHT && savedR <= MAX_RIGHT) applyRightWidth(savedR, false);
  } catch (e) {}

  function attachDrag(el, side) {
    if (!el) return;
    var dragging = false;

    function getClientX(ev) {
      if (ev.touches && ev.touches.length > 0) return ev.touches[0].clientX;
      return ev.clientX;
    }

    function onStart(ev) {
      dragging = true;
      el.classList.add('dragging');
      document.body.classList.add('is-resizing');
      ev.preventDefault();
    }

    function onMove(ev) {
      if (!dragging) return;
      var x = getClientX(ev);
      if (side === 'left') {
        applyLeftWidth(x, false);
      } else {
        applyRightWidth(window.innerWidth - x, false);
      }
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      document.body.classList.remove('is-resizing');
      var cur = parseInt(getComputedStyle(root).getPropertyValue(side === 'left' ? '--tv-sidebar-width' : '--tv-player-width'), 10);
      if (!isNaN(cur)) {
        if (side === 'left') applyLeftWidth(cur, true);
        else applyRightWidth(cur, true);
      }
      if (tvState.viewMode === 'pdf' && tvState.currentSong) {
        renderCurrentTvSheet();
      }
    }

    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchend', onEnd);

    el.addEventListener('dblclick', function() {
      if (side === 'left') applyLeftWidth(DEFAULT_LEFT, true);
      else applyRightWidth(DEFAULT_RIGHT, true);
      showTvToast('↔ Ancho de panel restablecido', 1400);
      if (tvState.viewMode === 'pdf' && tvState.currentSong) renderCurrentTvSheet();
    });

    // Ajuste con flechas del control remoto Smart TV cuando el separador tiene foco
    el.addEventListener('keydown', function(ev) {
      var k = ev.key;
      var c = ev.keyCode;
      if (k === 'ArrowLeft' || c === 37 || k === 'ArrowRight' || c === 39) {
        ev.preventDefault();
        ev.stopPropagation();
        var delta = (k === 'ArrowRight' || c === 39) ? 24 : -24;
        var prop = side === 'left' ? '--tv-sidebar-width' : '--tv-player-width';
        var curW = parseInt(getComputedStyle(root).getPropertyValue(prop), 10) || (side === 'left' ? DEFAULT_LEFT : DEFAULT_RIGHT);
        if (side === 'left') applyLeftWidth(curW + delta, true);
        else applyRightWidth(curW - delta, true);
      }
    });
  }

  attachDrag(leftResizer, 'left');
  attachDrag(rightResizer, 'right');
}

function startPixelOrbiter() {
  if (oledOrbiterInterval) clearInterval(oledOrbiterInterval);
  var root = document.documentElement;
  // Micro-desplazamiento sub-visual estilo LG Screen Move (±2px cada 90s):
  // Totalmente imperceptible al ojo (el texto en Word se ve 100% fijo), pero rota subpíxeles OLED
  var offsets = [
    [0, 0], [1, 1], [2, 0], [1, -1],
    [0, -2], [-1, -1], [-2, 0], [-1, 1]
  ];
  var step = 0;

  oledOrbiterInterval = setInterval(function() {
    step = (step + 1) % offsets.length;
    var pair = offsets[step];
    root.style.setProperty('--oled-shift-x', pair[0] + 'px');
    root.style.setProperty('--oled-shift-y', pair[1] + 'px');
  }, 90000);
}

function resetInactivityTimer() {
  if (oledInactivityTimer) clearTimeout(oledInactivityTimer);
  // Requisito SSoT: La protección OLED NO oscurece la pantalla ni altera el brillo, solo oculta los botones fijos
}

function toggleTvOledBlackout(forceState) {
  const blackoutEl = document.getElementById('tv-oled-blackout');
  if (!blackoutEl) return;

  const isCurrentOpen = blackoutEl.style.display !== 'none';
  const shouldOpen = (forceState !== undefined) ? forceState : !isCurrentOpen;

  // En modo Karaoke JAMÁS activar pantalla negra / suspensión
  if (shouldOpen && tvState.viewMode === 'karaoke') {
    return;
  }

  if (shouldOpen) {
    blackoutEl.style.display = 'flex';
    document.body.classList.add('oled-blackout-active');
    const nowPlaying = document.getElementById('tv-oled-now-playing');
    if (nowPlaying && tvState.currentSong) {
      nowPlaying.textContent = `🎵 ${tvState.currentSong.artist} - ${tvState.currentSong.title}`;
    }
    showTvToast('🌑 Pantalla OLED apagada (0 Nits). Pulsa cualquier tecla o mueve el control para encender.', 3000);
    logTvAction('tv_oled_blackout_activated', { song: (tvState.currentSong ? tvState.currentSong.title : '') });
  } else {
    blackoutEl.style.display = 'none';
    document.body.classList.remove('oled-blackout-active');
    document.body.classList.remove('oled-dimmed');
    resetInactivityTimer();
    logTvAction('tv_oled_blackout_deactivated', {});
  }
}

// ==============================================================
// 8. GENERADOR INTERACTIVO DE DIAGRAMAS DE ACORDES DE GUITARRA (SSOT)
// ==============================================================
const CHORD_DATABASE = {
  // Mayores estándar
  'C': { frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0], baseFret: 1 },
  'D': { frets: [-1, -1, 0, 2, 3, 2], fingers: [0, 0, 0, 1, 3, 2], baseFret: 1 },
  'E': { frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0], baseFret: 1 },
  'F': { frets: [1, 3, 3, 2, 1, 1], fingers: [1, 3, 4, 2, 1, 1], baseFret: 1, barre: 1 },
  'G': { frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3], baseFret: 1 },
  'A': { frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0], baseFret: 1 },
  'B': { frets: [-1, 2, 4, 4, 4, 2], fingers: [0, 1, 2, 3, 4, 1], baseFret: 2, barre: 2 },

  // Menores estándar
  'Cm': { frets: [-1, 3, 5, 5, 4, 3], fingers: [0, 1, 3, 4, 2, 1], baseFret: 3, barre: 3 },
  'Dm': { frets: [-1, -1, 0, 2, 3, 1], fingers: [0, 0, 0, 2, 3, 1], baseFret: 1 },
  'Em': { frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0], baseFret: 1 },
  'Fm': { frets: [1, 3, 3, 1, 1, 1], fingers: [1, 3, 4, 1, 1, 1], baseFret: 1, barre: 1 },
  'Gm': { frets: [3, 5, 5, 3, 3, 3], fingers: [1, 3, 4, 1, 1, 1], baseFret: 3, barre: 3 },
  'Am': { frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0], baseFret: 1 },
  'Bm': { frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1], baseFret: 2, barre: 2 },

  // Sostenidos y bemoles mayores
  'C#': { frets: [-1, 4, 6, 6, 6, 4], fingers: [0, 1, 2, 3, 4, 1], baseFret: 4, barre: 4 },
  'Db': { frets: [-1, 4, 6, 6, 6, 4], fingers: [0, 1, 2, 3, 4, 1], baseFret: 4, barre: 4 },
  'D#': { frets: [-1, 6, 8, 8, 8, 6], fingers: [0, 1, 2, 3, 4, 1], baseFret: 6, barre: 6 },
  'Eb': { frets: [-1, 6, 8, 8, 8, 6], fingers: [0, 1, 2, 3, 4, 1], baseFret: 6, barre: 6 },
  'F#': { frets: [2, 4, 4, 3, 2, 2], fingers: [1, 3, 4, 2, 1, 1], baseFret: 2, barre: 2 },
  'Gb': { frets: [2, 4, 4, 3, 2, 2], fingers: [1, 3, 4, 2, 1, 1], baseFret: 2, barre: 2 },
  'G#': { frets: [4, 6, 6, 5, 4, 4], fingers: [1, 3, 4, 2, 1, 1], baseFret: 4, barre: 4 },
  'Ab': { frets: [4, 6, 6, 5, 4, 4], fingers: [1, 3, 4, 2, 1, 1], baseFret: 4, barre: 4 },
  'A#': { frets: [-1, 1, 3, 3, 3, 1], fingers: [0, 1, 2, 3, 4, 1], baseFret: 1, barre: 1 },
  'Bb': { frets: [-1, 1, 3, 3, 3, 1], fingers: [0, 1, 2, 3, 4, 1], baseFret: 1, barre: 1 },

  // Sostenidos y bemoles menores
  'C#m': { frets: [-1, 4, 6, 6, 5, 4], fingers: [0, 1, 3, 4, 2, 1], baseFret: 4, barre: 4 },
  'Dbm': { frets: [-1, 4, 6, 6, 5, 4], fingers: [0, 1, 3, 4, 2, 1], baseFret: 4, barre: 4 },
  'D#m': { frets: [-1, 6, 8, 8, 7, 6], fingers: [0, 1, 3, 4, 2, 1], baseFret: 6, barre: 6 },
  'Ebm': { frets: [-1, 6, 8, 8, 7, 6], fingers: [0, 1, 3, 4, 2, 1], baseFret: 6, barre: 6 },
  'F#m': { frets: [2, 4, 4, 2, 2, 2], fingers: [1, 3, 4, 1, 1, 1], baseFret: 2, barre: 2 },
  'Gbm': { frets: [2, 4, 4, 2, 2, 2], fingers: [1, 3, 4, 1, 1, 1], baseFret: 2, barre: 2 },
  'G#m': { frets: [4, 6, 6, 4, 4, 4], fingers: [1, 3, 4, 1, 1, 1], baseFret: 4, barre: 4 },
  'Abm': { frets: [4, 6, 6, 4, 4, 4], fingers: [1, 3, 4, 1, 1, 1], baseFret: 4, barre: 4 },
  'A#m': { frets: [-1, 1, 3, 3, 2, 1], fingers: [0, 1, 3, 4, 2, 1], baseFret: 1, barre: 1 },
  'Bbm': { frets: [-1, 1, 3, 3, 2, 1], fingers: [0, 1, 3, 4, 2, 1], baseFret: 1, barre: 1 },

  // Power Chords (Acordes de 5ta - Rock, Punk, Metal)
  'C5': { frets: [-1, 3, 5, 5, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 3 },
  'C#5': { frets: [-1, 4, 6, 6, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 4 },
  'Db5': { frets: [-1, 4, 6, 6, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 4 },
  'D5': { frets: [-1, 5, 7, 7, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 5 },
  'D#5': { frets: [-1, 6, 8, 8, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 6 },
  'Eb5': { frets: [-1, 6, 8, 8, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 6 },
  'E5': { frets: [0, 2, 2, -1, -1, -1], fingers: [0, 1, 2, 0, 0, 0], baseFret: 1 },
  'F5': { frets: [1, 3, 3, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], baseFret: 1 },
  'F#5': { frets: [2, 4, 4, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], baseFret: 2 },
  'Gb5': { frets: [2, 4, 4, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], baseFret: 2 },
  'G5': { frets: [3, 5, 5, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], baseFret: 3 },
  'G#5': { frets: [4, 6, 6, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], baseFret: 4 },
  'Ab5': { frets: [4, 6, 6, -1, -1, -1], fingers: [1, 3, 4, 0, 0, 0], baseFret: 4 },
  'A5': { frets: [-1, 0, 2, 2, -1, -1], fingers: [0, 0, 1, 2, 0, 0], baseFret: 1 },
  'A#5': { frets: [-1, 1, 3, 3, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 1 },
  'Bb5': { frets: [-1, 1, 3, 3, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 1 },
  'B5': { frets: [-1, 2, 4, 4, -1, -1], fingers: [0, 1, 3, 4, 0, 0], baseFret: 2 },

  // Séptimas dominantes
  'C7': { frets: [-1, 3, 2, 3, 1, 0], fingers: [0, 3, 2, 4, 1, 0], baseFret: 1 },
  'D7': { frets: [-1, -1, 0, 2, 1, 2], fingers: [0, 0, 0, 2, 1, 3], baseFret: 1 },
  'E7': { frets: [0, 2, 0, 1, 0, 0], fingers: [0, 2, 0, 1, 0, 0], baseFret: 1 },
  'F7': { frets: [1, 3, 1, 2, 1, 1], fingers: [1, 3, 1, 2, 1, 1], baseFret: 1, barre: 1 },
  'G7': { frets: [3, 2, 0, 0, 0, 1], fingers: [3, 2, 0, 0, 0, 1], baseFret: 1 },
  'A7': { frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 0, 2, 0, 3, 0], baseFret: 1 },
  'B7': { frets: [-1, 2, 1, 2, 0, 2], fingers: [0, 2, 1, 3, 0, 4], baseFret: 1 },
  'F#7': { frets: [2, 4, 2, 3, 2, 2], fingers: [1, 3, 1, 2, 1, 1], baseFret: 2, barre: 2 },
  'C#7': { frets: [-1, 4, 3, 4, 2, -1], fingers: [0, 3, 2, 4, 1, 0], baseFret: 3 },
  'Bb7': { frets: [-1, 1, 3, 1, 3, 1], fingers: [0, 1, 3, 1, 4, 1], baseFret: 1, barre: 1 },

  // Séptimas menores
  'Cm7': { frets: [-1, 3, 5, 3, 4, 3], fingers: [0, 1, 3, 1, 2, 1], baseFret: 3, barre: 3 },
  'Dm7': { frets: [-1, -1, 0, 2, 1, 1], fingers: [0, 0, 0, 2, 1, 1], baseFret: 1, barre: 1 },
  'Em7': { frets: [0, 2, 0, 0, 0, 0], fingers: [0, 2, 0, 0, 0, 0], baseFret: 1 },
  'Fm7': { frets: [1, 3, 1, 1, 1, 1], fingers: [1, 3, 1, 1, 1, 1], baseFret: 1, barre: 1 },
  'Gm7': { frets: [3, 5, 3, 3, 3, 3], fingers: [1, 3, 1, 1, 1, 1], baseFret: 3, barre: 3 },
  'Am7': { frets: [-1, 0, 2, 0, 1, 0], fingers: [0, 0, 2, 0, 1, 0], baseFret: 1 },
  'Bm7': { frets: [-1, 2, 4, 2, 3, 2], fingers: [0, 1, 3, 1, 2, 1], baseFret: 2, barre: 2 },
  'F#m7': { frets: [2, 4, 2, 2, 2, 2], fingers: [1, 3, 1, 1, 1, 1], baseFret: 2, barre: 2 },
  'C#m7': { frets: [-1, 4, 6, 4, 5, 4], fingers: [0, 1, 3, 1, 2, 1], baseFret: 4, barre: 4 },

  // Mayores con 7ma mayor (maj7)
  'Cmaj7': { frets: [-1, 3, 2, 0, 0, 0], fingers: [0, 3, 2, 0, 0, 0], baseFret: 1 },
  'Dmaj7': { frets: [-1, -1, 0, 2, 2, 2], fingers: [0, 0, 0, 1, 2, 3], baseFret: 1 },
  'Emaj7': { frets: [0, 2, 1, 1, 0, 0], fingers: [0, 3, 1, 2, 0, 0], baseFret: 1 },
  'Fmaj7': { frets: [-1, -1, 3, 2, 1, 0], fingers: [0, 0, 3, 2, 1, 0], baseFret: 1 },
  'Gmaj7': { frets: [3, 2, 0, 0, 0, 2], fingers: [2, 1, 0, 0, 0, 3], baseFret: 1 },
  'Amaj7': { frets: [-1, 0, 2, 1, 2, 0], fingers: [0, 0, 2, 1, 3, 0], baseFret: 1 },
  'Bmaj7': { frets: [-1, 2, 4, 3, 4, 2], fingers: [0, 1, 3, 2, 4, 1], baseFret: 2, barre: 2 },
  'Bbmaj7': { frets: [-1, 1, 3, 2, 3, 1], fingers: [0, 1, 3, 2, 4, 1], baseFret: 1, barre: 1 },

  // Suspendidos y Add9
  'Csus4': { frets: [-1, 3, 3, 0, 1, 1], fingers: [0, 3, 4, 0, 1, 1], baseFret: 1 },
  'Dsus4': { frets: [-1, -1, 0, 2, 3, 3], fingers: [0, 0, 0, 1, 2, 4], baseFret: 1 },
  'Esus4': { frets: [0, 2, 2, 2, 0, 0], fingers: [0, 2, 3, 4, 0, 0], baseFret: 1 },
  'Gsus4': { frets: [3, 3, 0, 0, 1, 3], fingers: [2, 3, 0, 0, 1, 4], baseFret: 1 },
  'Asus4': { frets: [-1, 0, 2, 2, 3, 0], fingers: [0, 0, 1, 2, 3, 0], baseFret: 1 },
  'Bsus4': { frets: [-1, 2, 4, 4, 5, 2], fingers: [0, 1, 2, 3, 4, 1], baseFret: 2, barre: 2 },
  'Dsus2': { frets: [-1, -1, 0, 2, 3, 0], fingers: [0, 0, 0, 1, 2, 0], baseFret: 1 },
  'Asus2': { frets: [-1, 0, 2, 2, 0, 0], fingers: [0, 0, 1, 2, 0, 0], baseFret: 1 },
  'Cadd9': { frets: [-1, 3, 2, 0, 3, 3], fingers: [0, 2, 1, 0, 3, 4], baseFret: 1 },
  'Gadd9': { frets: [3, 2, 0, 2, 0, 3], fingers: [2, 1, 0, 3, 0, 4], baseFret: 1 },

  // Slash chords comunes
  'D/F#': { frets: [2, 0, 0, 2, 3, 2], fingers: [1, 0, 0, 2, 4, 3], baseFret: 1 },
  'G/B': { frets: [-1, 2, 0, 0, 0, 3], fingers: [0, 1, 0, 0, 0, 3], baseFret: 1 },
  'C/G': { frets: [3, 3, 2, 0, 1, 0], fingers: [3, 4, 2, 0, 1, 0], baseFret: 1 },
  'Am/G': { frets: [3, 0, 2, 2, 1, 0], fingers: [4, 0, 2, 3, 1, 0], baseFret: 1 },
  'Em/D': { frets: [-1, -1, 0, 0, 0, 0], fingers: [0, 0, 0, 0, 0, 0], baseFret: 1 },
  'F/C': { frets: [-1, 3, 3, 2, 1, 1], fingers: [0, 3, 4, 2, 1, 1], baseFret: 1, barre: 1 },

  // Disminuidos
  'Cdim': { frets: [-1, 3, 4, 2, 4, -1], fingers: [0, 2, 3, 1, 4, 0], baseFret: 2 },
  'Ddim': { frets: [-1, -1, 0, 1, 3, 1], fingers: [0, 0, 0, 1, 3, 2], baseFret: 1 },
  'Edim': { frets: [-1, -1, 2, 3, 2, 3], fingers: [0, 0, 1, 3, 2, 4], baseFret: 2 },
  'Fdim': { frets: [-1, -1, 3, 4, 3, 4], fingers: [0, 0, 1, 3, 2, 4], baseFret: 3 },
  'Gdim': { frets: [-1, -1, 5, 6, 5, 6], fingers: [0, 0, 1, 3, 2, 4], baseFret: 5 },
  'Adim': { frets: [-1, 0, 1, 2, 1, -1], fingers: [0, 0, 1, 3, 2, 0], baseFret: 1 },
  'Bdim': { frets: [-1, 2, 3, 1, 3, -1], fingers: [0, 2, 3, 1, 4, 0], baseFret: 1 },
  'F#dim': { frets: [-1, -1, 4, 5, 4, 5], fingers: [0, 0, 1, 3, 2, 4], baseFret: 4 },
  'C#dim': { frets: [-1, 4, 5, 3, 5, -1], fingers: [0, 2, 3, 1, 4, 0], baseFret: 3 },

  // Con símbolo de grado °
  'C°': { frets: [-1, 3, 4, 2, 4, -1], fingers: [0, 2, 3, 1, 4, 0], baseFret: 2 },
  'D°': { frets: [-1, -1, 0, 1, 3, 1], fingers: [0, 0, 0, 1, 3, 2], baseFret: 1 },
  'E°': { frets: [-1, -1, 2, 3, 2, 3], fingers: [0, 0, 1, 3, 2, 4], baseFret: 2 },
  'F°': { frets: [-1, -1, 3, 4, 3, 4], fingers: [0, 0, 1, 3, 2, 4], baseFret: 3 },
  'G°': { frets: [-1, -1, 5, 6, 5, 6], fingers: [0, 0, 1, 3, 2, 4], baseFret: 5 },
  'A°': { frets: [-1, 0, 1, 2, 1, -1], fingers: [0, 0, 1, 3, 2, 0], baseFret: 1 },
  'B°': { frets: [-1, 2, 3, 1, 3, -1], fingers: [0, 2, 3, 1, 4, 0], baseFret: 1 },
  'F#°': { frets: [-1, -1, 4, 5, 4, 5], fingers: [0, 0, 1, 3, 2, 4], baseFret: 4 },
  'FA°': { frets: [-1, -1, 3, 4, 3, 4], fingers: [0, 0, 1, 3, 2, 4], baseFret: 3 }
};

const LATIN_CHORD_MAP = {
  'DO': 'C', 'RE': 'D', 'MI': 'E', 'FA': 'F', 'SOL': 'G', 'LA': 'A', 'SI': 'B',
  'Do': 'C', 'Re': 'D', 'Mi': 'E', 'Fa': 'F', 'Sol': 'G', 'La': 'A', 'Si': 'B'
};

function normalizeChordName(name) {
  if (!name) return '';
  let clean = name.trim().replace(/[(),:;]/g, '');
  clean = clean.replace(/[\/\-+—–]+$/, '').trim();
  if (clean === 'FA°') return 'FA°';

  // Si tiene bajo alterado tipo D/F# o LA/DO#
  const slashParts = clean.split('/');
  if (slashParts.length === 2) {
    const rootNorm = normalizeChordName(slashParts[0]);
    const bassNorm = normalizeChordName(slashParts[1]);
    const combined = `${rootNorm}/${bassNorm}`;
    if (CHORD_DATABASE[combined]) return combined;
    return rootNorm;
  }

  // Normalizar raíces latinas (DO, RE, MI, FA, SOL, LA, SI)
  for (const [lat, eng] of Object.entries(LATIN_CHORD_MAP)) {
    const reg = new RegExp('^' + lat + '(?=[#b♯♭0-9mMasu°]|$)', 'i');
    if (reg.test(clean)) {
      clean = clean.replace(reg, eng);
      break;
    }
  }

  // Normalizar alteraciones tipográficas
  clean = clean.replace(/♯/g, '#').replace(/♭/g, 'b');

  return clean;
}

function renderChordDiagramSvg(chordName) {
  const norm = normalizeChordName(chordName);
  const data = CHORD_DATABASE[norm] || CHORD_DATABASE[norm.toUpperCase()];

  const startX = 20;
  const startY = 32;
  const stringGap = 12;
  const fretGap = 16;
  const numFrets = 4;

  // REGLA SSoT: Si el acorde es inventado o no estándar, se renderiza EN BLANCO (sin puntos ni cejilla)
  if (!data || !data.frets) {
    let svg = `<svg viewBox="0 0 100 135" xmlns="http://www.w3.org/2000/svg" class="tv-chord-svg tv-chord-blank">
  <rect width="100" height="135" fill="#080d1a" rx="8" stroke="#334155" stroke-width="1.5"/>
  <text x="50" y="20" font-family="'Inter', sans-serif" font-size="13" font-weight="800" fill="#94a3b8" text-anchor="middle">${escapeHtml(chordName)}</text>
  <!-- Cejuela vacía -->
  <line x1="${startX}" y1="${startY}" x2="${startX + stringGap * 5}" y2="${startY}" stroke="#64748b" stroke-width="3"/>`;

    // Trastes horizontales vacíos
    for (let f = 1; f <= numFrets; f++) {
      const y = startY + f * fretGap;
      svg += `\n  <line x1="${startX}" y1="${y}" x2="${startX + stringGap * 5}" y2="${y}" stroke="#1e293b" stroke-width="1"/>`;
    }

    // 6 Cuerdas verticales vacías
    for (let s = 0; s < 6; s++) {
      const x = startX + s * stringGap;
      svg += `\n  <line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + numFrets * fretGap}" stroke="#334155" stroke-width="1"/>`;
    }

    // Etiqueta discreta de acorde en blanco
    svg += `\n  <text x="50" y="118" font-family="'Inter', sans-serif" font-size="9" font-weight="600" fill="#64748b" text-anchor="middle">En blanco</text>`;
    svg += '\n</svg>';
    return svg;
  }

  // Acorde estándar con digitación real
  const { frets, fingers, baseFret = 1, barre = null } = data;

  let svg = `<svg viewBox="0 0 100 135" xmlns="http://www.w3.org/2000/svg" class="tv-chord-svg">
  <rect width="100" height="135" fill="#080d1a" rx="8" stroke="#1e293b" stroke-width="1.5"/>
  <text x="50" y="20" font-family="'Inter', sans-serif" font-size="13" font-weight="800" fill="#f59e0b" text-anchor="middle">${escapeHtml(chordName)}</text>`;

  if (baseFret > 1) {
    svg += `\n  <text x="10" y="${startY + 12}" font-family="monospace" font-size="10" font-weight="bold" fill="#00f0ff">${baseFret}fr</text>`;
  } else {
    svg += `\n  <line x1="${startX}" y1="${startY}" x2="${startX + stringGap * 5}" y2="${startY}" stroke="#94a3b8" stroke-width="3"/>`;
  }

  for (let f = 0; f <= numFrets; f++) {
    const y = startY + f * fretGap;
    svg += `\n  <line x1="${startX}" y1="${y}" x2="${startX + stringGap * 5}" y2="${y}" stroke="#334155" stroke-width="1.2"/>`;
  }

  for (let s = 0; s < 6; s++) {
    const x = startX + s * stringGap;
    svg += `\n  <line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + numFrets * fretGap}" stroke="#475569" stroke-width="1.2"/>`;
  }

  if (barre) {
    const relFret = barre - baseFret + 1;
    if (relFret >= 1 && relFret <= numFrets) {
      const y = startY + (relFret - 0.5) * fretGap;
      svg += `\n  <rect x="${startX - 2}" y="${y - 4}" width="${stringGap * 5 + 4}" height="8" rx="4" fill="#00f0ff" opacity="0.85"/>`;
    }
  }

  frets.forEach((fret, sIdx) => {
    const x = startX + sIdx * stringGap;
    if (fret === -1) {
      svg += `\n  <text x="${x}" y="${startY - 4}" font-family="'Inter', sans-serif" font-size="11" font-weight="bold" fill="#ef4444" text-anchor="middle">✕</text>`;
    } else if (fret === 0) {
      svg += `\n  <circle cx="${x}" cy="${startY - 5}" r="3" fill="none" stroke="#10b981" stroke-width="1.5"/>`;
    } else {
      const relFret = fret - baseFret + 1;
      if (relFret >= 1 && relFret <= numFrets) {
        const y = startY + (relFret - 0.5) * fretGap;
        const finger = fingers ? fingers[sIdx] : '';
        svg += `\n  <circle cx="${x}" cy="${y}" r="5.5" fill="#00f0ff"/>`;
        if (finger) {
          svg += `\n  <text x="${x}" y="${y + 3.5}" font-family="'Inter', sans-serif" font-size="9" font-weight="bold" fill="#020617" text-anchor="middle">${finger}</text>`;
        }
      }
    }
  });

  svg += '\n</svg>';
  return svg;
}

function isChordToken(w) {
  if (!w) return false;
  const c = w.replace(/^[(\[]+|[)\].,:;\-+—–\/]+$/g, '').trim();
  if (!c || c.length > 8) return false;
  if (/^(x\d+|\d+x|x|\d+|Intro|Verso|Coro|Estribillo|Puente|Solo|Outro|Final|Fin|Riff|Bis|Parte|Coda|ESQUEMA|AFINACION|LETRA)$/i.test(c)) return false;

  const engRegex = /^[A-G][#b♯♭]?(?:m|maj|min|dim|aug|sus|add)?[0-9]*(?:\/[A-G][#b♯♭]?)?$/i;
  const latRegex = /^(?:DO|RE|MI|FA|SOL|LA|SI)[#b♯♭]?(?:m|maj|min|dim|aug|sus|add)?[0-9]*(?:\/(?:DO|RE|MI|FA|SOL|LA|SI)[#b♯♭]?)?$/i;
  const degRegex = /^(?:[A-G]|DO|RE|MI|FA|SOL|LA|SI)[#b♯♭]?°$/i;
  const invRegex = /^[A-G][#b♯♭]?[0-9]+$/i;

  return engRegex.test(c) || latRegex.test(c) || degRegex.test(c) || invRegex.test(c);
}

function extractSongChords(song) {
  if (!song) return [];
  const chords = [];
  const seen = new Set();

  function addChord(c) {
    if (!c) return;
    const clean = c.replace(/^[(\[]+|[)\].,:;\-+—–\/]+$/g, '').trim();
    if (!clean || clean.length > 8 || !isChordToken(clean)) return;

    const key = clean.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      chords.push(clean);
    }
  }

  // 1. Escanear páginas activas (Word doc)
  const activePages = (tvState.showingSpanish && song.spanishVersion && song.spanishVersion.pages)
    ? song.spanishVersion.pages
    : (song.pages && song.pages.length > 0 ? song.pages : [(song.raw_lines || [])]);

  if (Array.isArray(activePages)) {
    activePages.forEach(page => {
      if (Array.isArray(page)) {
        page.forEach(line => {
          if (!line) return;
          const text = typeof line === 'string' ? line : (line.text || '');
          if (!text) return;
          const trimmed = text.trim();

          const tokens = trimmed.split(/[\s\-–—,]+/).filter(Boolean);
          const chordTokens = tokens.filter(isChordToken);

          const isExplicitChordLine = typeof line === 'object' && line.lineType === 'chords';
          const isStructureLine = /^(Intro|Verso|Coro|Estribillo|Puente|Solo|Outro|ESQUEMA)/i.test(trimmed) && /[:\-]/.test(trimmed);
          const isPredominantlyChords = tokens.length > 0 && (chordTokens.length / tokens.length >= 0.4);

          if (isExplicitChordLine || isStructureLine || isPredominantlyChords) {
            chordTokens.forEach(addChord);
          } else {
            // Capturar acordes entre corchetes dentro de la letra [Am]
            const bracketMatches = trimmed.match(/\[([A-G][#b]?[0-9a-z]*|DO|RE|MI|FA|SOL|LA|SI)\]/gi);
            if (bracketMatches) {
              bracketMatches.forEach(bm => addChord(bm.replace(/[\[\]]/g, '')));
            }
          }
        });
      }
    });
  }

  // 2. Escanear esquema general si está definido
  if (song.chordsScheme && typeof song.chordsScheme === 'string') {
    const tokens = song.chordsScheme.split(/[\s\-–—,:\n]+/).filter(isChordToken);
    tokens.forEach(addChord);
  }

  // 3. Fallback: si no se detectó ningún acorde en la letra pero existe `song.tone`
  if (chords.length === 0 && song.tone) {
    addChord(song.tone);
  }

  return chords;
}

function renderTvChords(song) {
  const container = document.getElementById('tv-chords-grid');
  const badge = document.getElementById('tv-chords-badge');
  if (!container) return;

  const chords = extractSongChords(song);

  if (badge) {
    badge.textContent = `${chords.length} acorde${chords.length === 1 ? '' : 's'}`;
  }

  if (chords.length === 0) {
    container.innerHTML = `<div class="tv-chords-empty">No se detectaron acordes específicos para esta canción</div>`;
    return;
  }

  let html = '';
  chords.forEach(c => {
    const norm = normalizeChordName(c);
    const data = CHORD_DATABASE[norm] || CHORD_DATABASE[norm.toUpperCase()];
    const isBlank = !data || !data.frets;
    const blankCls = isBlank ? ' tv-chord-blank-card' : '';
    html += `
      <div class="tv-chord-card${blankCls}" data-chord="${escapeHtml(c)}" tabindex="0" title="Acorde ${escapeHtml(c)} (Clic para escuchar rasgueo)">
        ${renderChordDiagramSvg(c)}
      </div>
    `;
  });
  container.innerHTML = html;

  // Interacción: Al hacer clic en un acorde, reproducir rasgueo sintético
  container.querySelectorAll('.tv-chord-card').forEach(card => {
    card.addEventListener('click', () => {
      const chordName = card.dataset.chord;
      playGuitarChordSound(chordName);
      showTvToast(`🎸 Acorde: ${chordName}`, 1200);
      logTvAction('tv_chord_clicked', { chord: chordName, song: song.title });
    });
  });
}

// Sintetizador Web Audio API para rasgueo de guitarra acústica
let tvAudioCtx = null;
function playGuitarChordSound(chordName) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!tvAudioCtx) tvAudioCtx = new AudioContext();
    if (tvAudioCtx.state === 'suspended') tvAudioCtx.resume();

    const norm = normalizeChordName(chordName);
    const data = CHORD_DATABASE[norm] || CHORD_DATABASE[norm.toUpperCase()];
    if (!data || !data.frets) return; // Si es acorde en blanco / inventado, no sintetizar

    // Frecuencias afinación estándar guitarra EADGBE: E2=82.41, A2=110, D3=146.83, G3=196, B3=246.94, E4=329.63
    const baseFreqs = [82.41, 110.00, 146.83, 196.00, 246.94, 329.63];
    const now = tvAudioCtx.currentTime;

    data.frets.forEach((fret, stringIdx) => {
      if (fret < 0) return; // Cuerda apagada
      const freq = baseFreqs[stringIdx] * Math.pow(2, fret / 12);
      const strTime = now + (stringIdx * 0.025); // Desfase natural de rasgueo

      const osc = tvAudioCtx.createOscillator();
      const gain = tvAudioCtx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, strTime);

      gain.gain.setValueAtTime(0.001, strTime);
      gain.gain.linearRampToValueAtTime(0.2, strTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, strTime + 1.2);

      osc.connect(gain);
      gain.connect(tvAudioCtx.destination);

      osc.start(strTime);
      osc.stop(strTime + 1.25);
    });
  } catch (err) {
    console.warn('Audio synthesis failed:', err.message);
  }
}

// Arranque al cargar DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTvApp);
} else {
  initTvApp();
}


// ==============================================================
// 9. INFORME COMPLETO DE MARCAS Y FALLAS PARA COMPARTIR (SIN EDICIÓN EN TV)
// ==============================================================
var tvActiveShareFilter = 'all';

function getTvUnifiedCatalogForReport() {
  var byId = {};
  var out = [];
  function pushArr(arr, bookName) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (!s || !s.id || byId[s.id]) continue;
      var copy = Object.assign({}, s, { book: s.book || bookName });
      byId[s.id] = copy;
      out.push(copy);
    }
  }
  pushArr(window.STANDALONE_SONGS, 'principal');
  pushArr(window.STANDALONE_REGGAETON, 'reggaeton');
  pushArr(window.STANDALONE_FALTANTES, 'faltantes');
  return out;
}

function getTvMarkedSongsCatalog() {
  var allList = getTvUnifiedCatalogForReport();
  var favs = [];
  var badChords = [];
  var badLyrics = [];
  var badSyncs = [];
  var uniqueMap = {};
  var totalUnique = 0;

  for (var i = 0; i < allList.length; i++) {
    var s = allList[i];
    var m = getTvSongMark(s);
    var hasAny = false;
    if (m.fav) { favs.push(s); hasAny = true; }
    if (m.badChord) { badChords.push(s); hasAny = true; }
    if (m.badLyric) { badLyrics.push(s); hasAny = true; }
    if (m.badSync) { badSyncs.push(s); hasAny = true; }
    if (hasAny && !uniqueMap[s.id]) {
      uniqueMap[s.id] = true;
      totalUnique++;
    }
  }
  return {
    favs: favs,
    badChords: badChords,
    badLyrics: badLyrics,
    badSyncs: badSyncs,
    totalUnique: totalUnique
  };
}

function formatTvSongLineForShare(s, extraTag) {
  var num = (s.playlistIndex || s.order) ? ('#' + (s.playlistIndex || s.order) + ' ') : '';
  var tone = s.tone ? (' [' + s.tone + ']') : '';
  var bookTag = s.book === 'reggaeton' ? ' (Reg)' : (s.book === 'faltantes' ? ' (Fal)' : '');
  var extra = extraTag ? (' — ' + extraTag) : '';
  return '• ' + num + (s.artist || 'Artista') + ' - ' + (s.title || 'Canción') + tone + bookTag + extra;
}

function buildTvMarksShareReport(filter) {
  if (!filter) filter = 'all';
  var cat = getTvMarkedSongsCatalog();

  var elAll = document.getElementById('tv-share-count-all');
  var elFav = document.getElementById('tv-share-count-fav');
  var elChord = document.getElementById('tv-share-count-chord');
  var elLyric = document.getElementById('tv-share-count-lyric');
  var elSync = document.getElementById('tv-share-count-sync');
  if (elAll) elAll.textContent = cat.totalUnique;
  if (elFav) elFav.textContent = cat.favs.length;
  if (elChord) elChord.textContent = cat.badChords.length;
  if (elLyric) elLyric.textContent = cat.badLyrics.length;
  if (elSync) elSync.textContent = cat.badSyncs.length;

  var lines = [];
  var dateStr = '';
  try { dateStr = new Date().toLocaleDateString('es-CL'); } catch (e) { dateStr = new Date().toISOString().slice(0, 10); }
  lines.push('📋 *INFORME DE FALLAS Y FAVORITAS — CANCIONERO TV* (' + dateStr + ')');
  lines.push('Resumen: ' + cat.favs.length + ' favoritas · ' + cat.badChords.length + ' acordes malos · ' + cat.badLyrics.length + ' letras malas · ' + cat.badSyncs.length + ' sincro mala');

  if (cat.totalUnique === 0) {
    lines.push('');
    lines.push('Aún no hay canciones marcadas en ninguno de los cancioneros (Principal, Reggaetón o Faltantes).');
    lines.push('Usa ♥ Favorita, Acorde ✗, Letra ✗ o Sincro ✗ mientras escuchas canciones para registrar fallas y compartirlas al final.');
    return lines.join('\n');
  }

  if (filter === 'all' || filter === 'fav') {
    if (cat.favs.length > 0) {
      lines.push('');
      lines.push('❤️ *FAVORITAS (' + cat.favs.length + '):*');
      for (var f = 0; f < cat.favs.length; f++) lines.push(formatTvSongLineForShare(cat.favs[f], ''));
    } else if (filter === 'fav') {
      lines.push('\nNo hay canciones marcadas como Favoritas.');
    }
  }

  if (filter === 'all' || filter === 'badChord') {
    if (cat.badChords.length > 0) {
      lines.push('');
      lines.push('🎸 *ACORDES MALOS A CORREGIR (' + cat.badChords.length + '):*');
      for (var c = 0; c < cat.badChords.length; c++) lines.push(formatTvSongLineForShare(cat.badChords[c], 'Revisar acordes'));
    } else if (filter === 'badChord') {
      lines.push('\nNo hay canciones marcadas con Acordes malos.');
    }
  }

  if (filter === 'all' || filter === 'badLyric') {
    if (cat.badLyrics.length > 0) {
      lines.push('');
      lines.push('📝 *LETRA MALA A CORREGIR (' + cat.badLyrics.length + '):*');
      for (var l = 0; l < cat.badLyrics.length; l++) lines.push(formatTvSongLineForShare(cat.badLyrics[l], 'Revisar letra'));
    } else if (filter === 'badLyric') {
      lines.push('\nNo hay canciones marcadas con Letra mala.');
    }
  }

  if (filter === 'all' || filter === 'badSync') {
    if (cat.badSyncs.length > 0) {
      lines.push('');
      lines.push('⏱️ *SINCRONIZACIÓN MALA A CORREGIR (' + cat.badSyncs.length + '):*');
      for (var s = 0; s < cat.badSyncs.length; s++) lines.push(formatTvSongLineForShare(cat.badSyncs[s], 'Revisar sincronización'));
    } else if (filter === 'badSync') {
      lines.push('\nNo hay canciones marcadas con Sincronización mala.');
    }
  }

  return lines.join('\n');
}

function renderTvShareQr(reportText) {
  var qrBox = document.getElementById('tv-share-qr-box');
  if (!qrBox) return;
  if (typeof window.qrcode !== 'function') {
    qrBox.style.display = 'none';
    return;
  }
  try {
    var payload = 'https://api.whatsapp.com/send?text=' + encodeURIComponent(reportText);
    if (payload.length > 1800) {
      payload = 'https://api.whatsapp.com/send?text=' + encodeURIComponent(reportText.slice(0, 900) + '\n... (usa Copiar para el informe completo)');
    }
    var qr = window.qrcode(0, 'L');
    qr.addData(payload);
    qr.make();
    qrBox.style.display = 'flex';
    qrBox.innerHTML =
      '<img src="' + qr.createDataURL(4, 8) + '" alt="QR WhatsApp Informe" class="tv-share-qr-img">' +
      '<span class="tv-share-qr-caption">📱 Escanea desde tu celular para abrir el informe en WhatsApp</span>';
  } catch (e) {
    qrBox.style.display = 'none';
  }
}

function openTvShareMarksModal() {
  var modal = document.getElementById('tv-share-marks-modal');
  var textarea = document.getElementById('tv-share-marks-textarea');
  if (!modal) return;
  loadTvSongMarks();
  var report = buildTvMarksShareReport(tvActiveShareFilter);
  if (textarea) textarea.value = report;
  renderTvShareQr(report);
  modal.style.display = 'flex';
  logTvAction('tv_share_marks_opened', { filter: tvActiveShareFilter });
}

function closeTvShareMarksModal() {
  var modal = document.getElementById('tv-share-marks-modal');
  if (modal) modal.style.display = 'none';
}

function initTvShareMarksModal() {
  on('btn-tv-share-marks', 'click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    openTvShareMarksModal();
  });

  on('btn-close-tv-share-marks', 'click', closeTvShareMarksModal);

  var modal = document.getElementById('tv-share-marks-modal');
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeTvShareMarksModal();
    });
  }

  document.querySelectorAll('.tv-share-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      tvActiveShareFilter = tab.getAttribute('data-share-filter') || 'all';
      document.querySelectorAll('.tv-share-tab').forEach(function(t) {
        t.classList.toggle('active', t === tab);
      });
      var report = buildTvMarksShareReport(tvActiveShareFilter);
      var textarea = document.getElementById('tv-share-marks-textarea');
      if (textarea) textarea.value = report;
      renderTvShareQr(report);
    });
  });

  on('btn-tv-share-wa', 'click', function() {
    var textarea = document.getElementById('tv-share-marks-textarea');
    var text = (textarea && textarea.value) || buildTvMarksShareReport(tvActiveShareFilter);
    window.open('https://api.whatsapp.com/send?text=' + encodeURIComponent(text), '_blank');
    logTvAction('tv_share_marks_whatsapp', { filter: tvActiveShareFilter });
  });

  on('btn-tv-share-native', 'click', function() {
    var textarea = document.getElementById('tv-share-marks-textarea');
    var text = (textarea && textarea.value) || buildTvMarksShareReport(tvActiveShareFilter);
    if (navigator.share) {
      navigator.share({ title: 'Informe Cancionero TV', text: text }).catch(function() {});
      return;
    }
    copyTvTextToClipboard(text, textarea);
  });

  on('btn-tv-share-copy', 'click', function() {
    var textarea = document.getElementById('tv-share-marks-textarea');
    var text = (textarea && textarea.value) || buildTvMarksShareReport(tvActiveShareFilter);
    copyTvTextToClipboard(text, textarea);
  });
}

function copyTvTextToClipboard(text, textarea) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showTvToast('📋 Informe copiado al portapapeles', 2000);
    }).catch(function() {
      fallbackCopyTvText(textarea);
    });
  } else {
    fallbackCopyTvText(textarea);
  }
}

function fallbackCopyTvText(textarea) {
  if (textarea) {
    try {
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      showTvToast('📋 Informe copiado al portapapeles', 2000);
    } catch (e) {}
  }
}


// ==============================================================
// 10. SELECTOR DE IDIOMA (ORIGINAL / ESPAÑOL) EN CANCIONES CON TRADUCCIÓN
// ==============================================================
function detectTvOriginalLangBadge(song) {
  if (!song) return '🌐 Original';
  var sample = String(song.title || '') + ' ' + String(song.artist || '');
  try {
    var pages = song.pages || [];
    if (pages[0] && Array.isArray(pages[0])) {
      for (var i = 0; i < Math.min(12, pages[0].length); i++) {
        var l = pages[0][i];
        sample += ' ' + (typeof l === 'string' ? l : (l && l.text ? l.text : ''));
      }
    }
  } catch (e) {}
  if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(sample)) return '🇯🇵 Original';
  return '🌐 Original';
}

function updateTvLangToggleUI(song) {
  var group = document.getElementById('tv-lang-toggle-group');
  var btnOrig = document.getElementById('btn-tv-lang-orig');
  var btnEs = document.getElementById('btn-tv-lang-es');
  if (!group) return;

  var hasTr = !!(song && song.hasTranslation && song.spanishVersion);
  if (hasTr) {
    group.style.display = 'inline-flex';
    if (btnOrig) {
      btnOrig.textContent = detectTvOriginalLangBadge(song);
      btnOrig.classList.toggle('active', !tvState.showingSpanish);
    }
    if (btnEs) {
      btnEs.classList.toggle('active', !!tvState.showingSpanish);
    }
  } else {
    group.style.display = 'none';
    tvState.showingSpanish = false;
  }
}

function setTvSongLanguage(useSpanish) {
  var song = tvState.currentSong;
  if (!song || !song.hasTranslation || !song.spanishVersion) return;
  var target = !!useSpanish;
  if (tvState.showingSpanish === target) return;
  tvState.showingSpanish = target;
  tvState.pdfPageOffset = 0;
  updateTvLangToggleUI(song);
  renderCurrentTvSheet();
  renderTvChords(song);
  showTvToast(target ? '🇪🇸 Mostrando versión traducida al español' : '🌐 Mostrando versión en idioma original', 1600);
  logTvAction('tv_language_toggled', { showingSpanish: target });
}
