/**
 * @file scoreSplitEngine.js
 * @description Motor SSoT v3.9.0 de Partituras Reales y Songsterr Oficial (0 tablaturas sintéticas/inventadas):
 *  - Modo Songsterr Oficial Anclado: Ancla la vista oficial de Songsterr (Cuenta Básica a velocidad 1x original)
 *    exactamente dentro de #score-scroll-container justo encima de #player-bar, funcionando en paralelo con
 *    el reproductor de la Playlist de YouTube y ocultándose automáticamente al abrir cajones, modales o editor.
 *  - Modo Guitar Pro / Riff Real 6 Cuerdas: Renderiza archivos .gp/.gp5 reales multipista, ediciones "Listas"
 *    de Estación 3 y riffs ASCII reales del Cancionero en 1 línea oscura estilo Songsterr sincronizada con la Playlist.
 */

(function () {
  const DB_NAME = 'cancionero_scores_v1';
  const STORE_NAME = 'gp_files';
  const LIVE_CACHE_KEY = 'songsterr_live_cache_v1';
  const PREF_OPEN_KEY = 'cancionero_score_strip_open_v1';
  const PREF_STAVE_KEY = 'cancionero_score_stave_v2';
  const PREF_SIZE_KEY = 'cancionero_score_size_v39';

  const SCORE_HEIGHTS = [
    { key: 'S', css: '148px', nativePct: 28, scale: 0.72 },
    { key: 'M', css: '188px', nativePct: 34, scale: 0.84 },
    { key: 'L', css: '236px', nativePct: 44, scale: 0.94 }
  ];

  /**
   * Convierte bloques ASCII reales editados en Estación 3 ("Lista") en compases AlphaTex de 6 cuerdas.
   */
  function parseLiveAsciiTabToBars(rawTabText) {
    if (!rawTabText || typeof rawTabText !== 'string') return [];
    const lines = rawTabText.split(/\r?\n/);
    const prefixRe = /^(?:([eBGDAE1-6])[ªa]?|(mi|si|sol|re|la|do)#?)\s*[\|\/:-]\s*(.*)$/i;
    const bareRe = /^[-\d\|\/hHpPbBsS~xX*.\s]{12,}$/;

    const matchRow = (ln) => {
      const s = String(ln || '').trim();
      if (!s) return null;
      const m = s.match(prefixRe);
      if (m && (m[3].match(/-/g) || []).length >= 4) return m[3].replace(/[\|\/]+$/, '');
      if (bareRe.test(s) && (s.match(/-/g) || []).length >= 8 && !/[a-wyzñáéíóú]{3,}/i.test(s)) {
        return s.replace(/^[\|\/]+|[\|\/]+$/g, '');
      }
      return null;
    };

    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      if (matchRow(lines[i]) !== null) {
        const blk = [];
        let k = i;
        while (k < lines.length && matchRow(lines[k]) !== null && blk.length < 6) {
          blk.push(matchRow(lines[k]));
          k++;
        }
        if (blk.length >= 4) {
          blocks.push(blk);
          i = k - 1;
        }
      }
    }

    const outBars = [];
    for (const rows of blocks) {
      const strOffset = rows.length === 4 ? 2 : 0;
      const minLen = Math.min(...rows.map(r => r.length));
      if (minLen < 4) continue;
      const events = [];
      let col = 0;
      while (col < minLen) {
        const notes = [];
        let twoDigit = false;
        for (let r = 0; r < rows.length; r++) {
          const ch = rows[r][col];
          if (ch >= '0' && ch <= '9') {
            const nx = col + 1 < minLen ? rows[r][col + 1] : '';
            let fret = parseInt(ch, 10);
            if (nx >= '0' && nx <= '9') {
              const t = parseInt(ch + nx, 10);
              if (t <= 24) { fret = t; twoDigit = true; }
            }
            notes.push(`${fret}.${Math.min(6, r + 1 + strOffset)}`);
          }
        }
        if (notes.length > 0) {
          events.push(notes.length === 1 ? notes[0] : `(${notes.join(' ')})`);
          col += twoDigit ? 2 : 1;
        } else {
          col += 1;
        }
      }
      for (let i = 0; i < events.length; i += 8) {
        const sl = events.slice(i, i + 8);
        if (!sl.length) continue;
        const pad = 8 - sl.length;
        outBars.push(sl.map(e => `${e}.8`).join(' ') + (pad > 0 ? ' r.8'.repeat(pad) : ''));
      }
    }
    return outBars.slice(0, 64);
  }

  const mgr = {
    isPanelOpen: false,
    isNativeSplitOpen: false,
    sizeIdx: 1, // 'M' (224px) por defecto para Songsterr y Tab 6C cómodos sobre el reproductor
    staveMode: 'tab',
    forcedModeForCurrentSong: null, // 'songsterr' | 'alphatab' | null
    api: null,
    activeTrackIdx: 0,
    currentSong: null,
    currentScoreMode: null, // 'customGp' | 'realGp' | 'asciiRiff' | 'empty'
    currentBaseOnsetSec: 0,
    currentTempoScale: 1.0,
    currentLoopRiff: false,
    offsetSec: 0,
    syncTimer: null,
    lastLoadedKey: '',
    renderedTimeline: null,
    userTouchHoldUntil: 0,
    pointerDownX: 0,
    pointerMoved: false,
    customGpIndexSet: new Set(),
    liveSongsterrCache: {},
    pendingFileSongId: null,
    resizeObs: null,
    overlayObs: null
  };

  try {
    const savedStave = localStorage.getItem(PREF_STAVE_KEY);
    if (savedStave === 'tab' || savedStave === 'scoreTab') mgr.staveMode = savedStave;
    mgr.sizeIdx = 1; // Fijo en tamaño M permanentemente
  } catch (_) {}

  function normText(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function loadLiveCache() {
    try {
      const raw = localStorage.getItem(LIVE_CACHE_KEY);
      if (raw) mgr.liveSongsterrCache = JSON.parse(raw) || {};
    } catch (_) {}
  }

  function saveLiveCache() {
    try {
      localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(mgr.liveSongsterrCache));
    } catch (_) {}
  }

  function saveOpenPref(isOpen) {
    try {
      localStorage.setItem(PREF_OPEN_KEY, isOpen ? '1' : '0');
    } catch (_) {}
  }

  function openScoresDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB no disponible'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'songId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function refreshCustomGpKeys() {
    try {
      const db = await openScoresDb();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAllKeys();
      req.onsuccess = () => {
        mgr.customGpIndexSet = new Set(Array.isArray(req.result) ? req.result : []);
        if (mgr.currentSong) updateToggleButtonForSong(mgr.currentSong);
        if (typeof renderDrawerList === 'function') renderDrawerList();
      };
    } catch (_) {}
  }

  async function saveCustomGpFile(songId, file) {
    if (!songId || !file) return false;
    const buf = await file.arrayBuffer();
    const db = await openScoresDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        songId,
        fileName: file.name || 'partitura.gp',
        bytes: buf,
        savedAt: new Date().toISOString()
      });
      tx.oncomplete = () => {
        mgr.customGpIndexSet.add(songId);
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getCustomGpFile(songId) {
    if (!songId) return null;
    try {
      const db = await openScoresDb();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(songId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  function getStaticScoreMeta(song) {
    if (!song) return null;
    const db = window.STANDALONE_SONGSTERR_SCORES || {};
    const kId = song.karaokeLookupId || song.id;
    return db[song.id] || db[kId] || mgr.liveSongsterrCache[song.id] || null;
  }

  function extractLiveEditedTabBarsFromSong(song) {
    if (!song) return [];
    const chunks = [];
    if (song._editorReadyTabText) chunks.push(song._editorReadyTabText);
    else if (song._hasReadyEditor && song.tab) chunks.push(song.tab);
    if (song._hasReadyEditor && Array.isArray(song.raw_lines)) {
      const tabLines = song.raw_lines
        .filter(l => l && (l.lineType === 'tab' || /^[eBGDAE1-6]\s*[\|\/:-]/.test(String(l.text || '').trim())))
        .map(l => String(l.text || ''));
      if (tabLines.length >= 4) chunks.push(tabLines.join('\n'));
    }
    if (chunks.length === 0) return [];
    return parseLiveAsciiTabToBars(chunks.join('\n\n'));
  }

  function getSongScoreInfo(song) {
    if (!song) return null;
    const sidKey = song.karaokeLookupId || song.id;
    const hasCustom = mgr.customGpIndexSet.has(song.id) || mgr.customGpIndexSet.has(sidKey);
    const meta = getStaticScoreMeta(song);
    const liveTabBars = extractLiveEditedTabBarsFromSong(song);
    const hasLiveEditorTab = liveTabBars.length > 0;
    const hasRealGp = !!(meta && meta.gpTex);
    const hasAsciiRiff = !!(meta && meta.tex);
    const songsterrId = meta && meta.sid ? meta.sid : null;
    const songsterrUrl = songsterrId ? `https://www.songsterr.com/a/wa/song?id=${songsterrId}` : null;
    const searchPattern = encodeURIComponent(`${song.artist || ''} ${song.title || ''}`.trim());
    const songsterrSearchUrl = `https://www.songsterr.com/?pattern=${searchPattern}`;

    const hasLocalRealTab = hasCustom || hasLiveEditorTab || hasRealGp || hasAsciiRiff;
    const hasAnyRealTab = hasLocalRealTab || !!songsterrUrl;

    const gpOffsetSec = (meta && meta.gpOffsetSec != null)
      ? Number(meta.gpOffsetSec) || 0
      : ((meta && Number(meta.onsetSec)) || 0);
    const gpTempoScale = (meta && Number(meta.gpTempoScale) > 0.25 && Number(meta.gpTempoScale) < 3.0)
      ? Number(meta.gpTempoScale)
      : 1.0;

    return {
      hasAnyRealTab,
      hasLocalRealTab,
      hasCustom,
      customSongKey: mgr.customGpIndexSet.has(song.id) ? song.id : sidKey,
      hasLiveEditorTab,
      liveTabBars,
      hasRealGp,
      gpTex: hasRealGp ? meta.gpTex : null,
      gpTrack: (meta && Number(meta.gpTrack)) || 0,
      onsetSec: gpOffsetSec,
      gpOffsetSec,
      gpTempoScale,
      detectedBpm: (meta && Number(meta.detectedBpm)) || 0,
      hasAsciiRiff,
      tabTex: hasAsciiRiff ? meta.tex : null,
      tabStartSec: (meta && Number(meta.tabStartSec)) || gpOffsetSec,
      songsterrId,
      songsterrUrl,
      songsterrSearchUrl,
      tracks: (meta && meta.tr) || [],
      artist: (meta && meta.a) || song.artist || '',
      title: (meta && meta.t) || song.title || ''
    };
  }

  function resolvePreferredMode(info) {
    if (!info) return 'empty';
    if (info.hasLocalRealTab) return 'alphatab';
    return 'empty';
  }

  function updateToggleButtonForSong(song) {
    const btns = [
      document.getElementById('btn-toggle-score-panel'),
      document.getElementById('btn-toggle-score-panel-exp')
    ].filter(Boolean);
    if (btns.length === 0) return;

    const info = getSongScoreInfo(song);
    const active = mgr.isPanelOpen || mgr.isNativeSplitOpen;

    for (const btn of btns) {
      if (!info) {
        btn.style.display = 'none';
        btn.classList.remove('active', 'has-gp-sync');
        continue;
      }
      btn.style.display = 'inline-flex';
      btn.classList.toggle('active', active);
      btn.classList.toggle('has-gp-sync', info.hasAnyRealTab);
      const lbl = btn.querySelector('.score-pill-label-text') || (btn.id === 'btn-toggle-score-panel' ? document.getElementById('score-pill-label') : null);
      if (lbl) {
        lbl.textContent = active ? 'Tab ▲' : 'Tab';
      }
      btn.title = active
        ? 'Ocultar barra fija de tablatura 6 cuerdas'
        : 'Mostrar tablatura fija de 6 cuerdas sincronizada';
    }
  }

  async function discoverLiveSongsterrIfNeeded(song) {
    if (!song || !song.artist || !song.title) return null;
    const existing = getStaticScoreMeta(song);
    if (existing && existing.sid) return existing;
    if (mgr.liveSongsterrCache[song.id] !== undefined) return mgr.liveSongsterrCache[song.id];
    if (!window.AndroidBridge || typeof window.AndroidBridge.httpGet !== 'function') return null;

    try {
      const url = 'https://www.songsterr.com/api/songs?pattern=' + encodeURIComponent(`${song.artist} ${song.title}`) + '&size=25';
      const raw = window.AndroidBridge.httpGet(url);
      if (!raw) {
        mgr.liveSongsterrCache[song.id] = null;
        saveLiveCache();
        return null;
      }
      const list = JSON.parse(raw);
      const targetTitle = normText(song.title);
      const targetArtist = normText(song.artist);
      const hit = Array.isArray(list) ? list.find(item => {
        const it = normText(item.title);
        const ia = normText(item.artist);
        const artistMatch = !targetArtist || ia.includes(targetArtist) || targetArtist.includes(ia);
        if (!artistMatch) return false;
        return it === targetTitle || (targetTitle.length >= 5 && (it.startsWith(targetTitle + ' ') || targetTitle.startsWith(it + ' ')));
      }) : null;

      if (hit) {
        const entry = {
          ...(existing || {}),
          sid: hit.songId,
          a: hit.artist,
          t: hit.title,
          tr: (hit.tracks || []).slice(0, 4).map(t => ({ n: t.name || t.instrument, i: t.instrument }))
        };
        mgr.liveSongsterrCache[song.id] = entry;
        saveLiveCache();
        return entry;
      } else {
        mgr.liveSongsterrCache[song.id] = null;
        saveLiveCache();
      }
    } catch (_) {}
    return null;
  }

  function isAnyBlockingOverlayOpen() {
    const drawer = document.getElementById('songs-drawer');
    if (drawer && drawer.classList.contains('open')) return true;
    const ed = document.getElementById('embedded-editor-overlay');
    if (ed && !ed.classList.contains('hidden') && window.getComputedStyle(ed).display !== 'none') return true;
    if (document.querySelector('.modal-overlay.active')) return true;
    return false;
  }

  function syncOverlayVisibilityWithNative() {
    if (!window.AndroidBridge || typeof window.AndroidBridge.setSongsterrOverlayTemporarilyHidden !== 'function') return;
    try {
      window.AndroidBridge.setSongsterrOverlayTemporarilyHidden(isAnyBlockingOverlayOpen());
    } catch (_) {}
  }

  function computeScrollerRatios() {
    const scroller = document.getElementById('score-scroll-container');
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    if (!scroller || vh <= 0) return { topRatio: 0.60, heightRatio: 0.24 };
    const r = scroller.getBoundingClientRect();
    const topRatio = Math.max(0.05, Math.min(0.90, r.top / vh));
    const heightRatio = Math.max(0.10, Math.min(0.75, r.height / vh));
    return { topRatio, heightRatio };
  }

  function syncNativeDockedRect() {
    if (!mgr.isNativeSplitOpen) return;
    if (!window.AndroidBridge || typeof window.AndroidBridge.updateSongsterrSplitRect !== 'function') return;
    const { topRatio, heightRatio } = computeScrollerRatios();
    try {
      window.AndroidBridge.updateSongsterrSplitRect(topRatio, heightRatio);
    } catch (_) {}
  }

  function openExternalSongsterr(song, info) {
    const resolved = info || getSongScoreInfo(song) || {};
    const targetUrl = resolved.songsterrUrl || resolved.songsterrSearchUrl || 'https://www.songsterr.com/';
    if (window.AndroidBridge && typeof window.AndroidBridge.openExternalUrl === 'function') {
      try {
        window.AndroidBridge.openExternalUrl(targetUrl);
        return;
      } catch (_) {}
    }
    try {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    } catch (_) {
      window.location.href = targetUrl;
    }
  }

  function configureToolbarForMode(mode, info) {
    const panel = document.getElementById('score-split-panel');
    const scroller = document.getElementById('score-scroll-container');
    const banner = document.getElementById('score-status-banner');
    const badge = document.getElementById('score-source-badge');
    const readout = document.getElementById('score-bar-readout');
    const sel = document.getElementById('score-track-select');
    const btnTrackCycle = document.getElementById('btn-score-track-cycle');
    const btnSwitch = document.getElementById('btn-score-mode-switch');
    const btnStave = document.getElementById('btn-score-stave');
    const btnMinus = document.getElementById('btn-score-offset-minus');
    const btnPlus = document.getElementById('btn-score-offset-plus');
    const btnSize = document.getElementById('btn-score-size');
    const btnReload = document.getElementById('btn-score-reload-st');

    if (btnReload) btnReload.style.display = 'none';
    if (btnMinus) btnMinus.style.display = 'none';
    if (btnPlus) btnPlus.style.display = 'none';
    if (btnSize) btnSize.style.display = 'none';

    if (mode === 'empty') {
      if (badge) {
        badge.innerHTML = '<span style="color:#ff4d6d; font-weight:900; letter-spacing:0.2px;">⚠️ Sin Tab</span>';
      }
      if (readout) readout.textContent = '';
      if (sel) sel.style.display = 'none';
      if (btnTrackCycle) btnTrackCycle.style.display = 'none';
      if (btnStave) btnStave.style.display = 'none';
      if (banner) banner.style.display = 'none';
      if (scroller) scroller.style.display = 'none';
      if (panel) {
        panel.style.height = 'auto';
        panel.style.minHeight = '0';
      }
    } else {
      if (badge) badge.textContent = '🎸 Tab';
      if (btnStave) btnStave.style.display = 'inline-flex';
      if (scroller) scroller.style.display = 'block';
    }
    if (btnSwitch) {
      btnSwitch.style.display = 'inline-flex';
      btnSwitch.textContent = '🌐 Songsterr';
      btnSwitch.title = 'Abrir en Songsterr en navegador externo';
    }
  }

  async function openDockedSongsterr(song, info) {
    const panel = document.getElementById('score-split-panel');
    const banner = document.getElementById('score-status-banner');
    const scroller = document.getElementById('score-scroll-container');
    const surface = document.getElementById('alphatab-surface');
    if (!panel) return;

    stopSyncTicker();
    hideNativeSongsterrOverlayOnly();
    mgr.isPanelOpen = true;
    mgr.currentScoreMode = 'empty';
    saveOpenPref(true);

    panel.style.display = 'flex';
    configureToolbarForMode('empty', info);
    if (surface) surface.style.visibility = 'hidden';
    if (banner) banner.style.display = 'none';
    if (scroller) scroller.style.display = 'none';
    updateToggleButtonForSong(song);
  }

  function buildRenderedTimeline() {
    mgr.renderedTimeline = null;
    if (!mgr.api || !mgr.api.renderer || !mgr.api.renderer.boundsLookup || !mgr.api.score) return;
    const lookup = mgr.api.renderer.boundsLookup;
    if (!Array.isArray(lookup.staffSystems) || lookup.staffSystems.length === 0) return;

    const masterBars = mgr.api.score.masterBars || [];
    let currentBpm = (mgr.api.score.tempo && Number(mgr.api.score.tempo) > 20) ? Number(mgr.api.score.tempo) : 120;
    let accSec = 0;
    const barTimes = [];

    for (let i = 0; i < masterBars.length; i++) {
      const mb = masterBars[i];
      if (mb && Array.isArray(mb.tempoAutomations) && mb.tempoAutomations.length > 0) {
        const ta = mb.tempoAutomations[0];
        if (ta && Number(ta.value) > 20) currentBpm = Number(ta.value);
      } else if (mb && mb.tempoAutomation && Number(mb.tempoAutomation.value) > 20) {
        currentBpm = Number(mb.tempoAutomation.value);
      }
      const num = (mb && Number(mb.timeSignatureNumerator)) || 4;
      const den = (mb && Number(mb.timeSignatureDenominator)) || 4;
      const quarterBeats = num * (4 / den);
      const durSec = quarterBeats * (60 / currentBpm);
      const durTicks = Math.round(quarterBeats * 960);
      barTimes.push({ startSec: accSec, endSec: accSec + durSec, durSec, durTicks });
      accSec += durSec;
    }

    const barsOut = [];
    for (const sys of lookup.staffSystems) {
      if (!sys || !Array.isArray(sys.bars)) continue;
      for (const mbb of sys.bars) {
        const idx = Number(mbb.index) || 0;
        const tInfo = barTimes[idx] || { startSec: idx * 2.0, endSec: (idx + 1) * 2.0, durSec: 2.0, durTicks: 3840 };
        const vb = mbb.visualBounds || mbb.realBounds || { x: 0, y: 8, w: 180, h: 96 };
        const beatsOut = [];
        if (Array.isArray(mbb.bars) && mbb.bars[0] && Array.isArray(mbb.bars[0].beats)) {
          const rawBeats = mbb.bars[0].beats;
          for (const bb of rawBeats) {
            if (!bb || !bb.beat) continue;
            const bStartTick = Number(bb.beat.playbackStart) || 0;
            const bDurTick = Math.max(60, Number(bb.beat.playbackDuration) || 480);
            const frac0 = Math.max(0, Math.min(1, bStartTick / Math.max(1, tInfo.durTicks)));
            const frac1 = Math.max(frac0 + 0.02, Math.min(1, (bStartTick + bDurTick) / Math.max(1, tInfo.durTicks)));
            const bvb = bb.visualBounds || { x: vb.x + frac0 * vb.w, y: vb.y, w: 16, h: vb.h };
            const noteX = typeof bb.onNotesX === 'number' ? bb.onNotesX : (bvb.x + bvb.w * 0.5);
            beatsOut.push({
              startSec: tInfo.startSec + frac0 * tInfo.durSec,
              endSec: tInfo.startSec + frac1 * tInfo.durSec,
              noteX,
              boxX: bvb.x,
              boxY: bvb.y,
              boxW: Math.max(12, bvb.w),
              boxH: bvb.h
            });
          }
          beatsOut.sort((a, b) => a.startSec - b.startSec);
        }
        barsOut.push({
          index: idx,
          startSec: tInfo.startSec,
          endSec: tInfo.endSec,
          durSec: tInfo.durSec,
          x: vb.x,
          y: vb.y,
          w: Math.max(20, vb.w),
          h: Math.max(48, vb.h),
          beats: beatsOut
        });
      }
    }

    if (barsOut.length > 0) {
      mgr.renderedTimeline = {
        bars: barsOut,
        totalDurationSec: barsOut[barsOut.length - 1].endSec
      };
    }
  }

  function ensureLivePlayheadElements() {
    const surface = document.getElementById('alphatab-surface');
    if (!surface) return null;
    let playhead = document.getElementById('score-live-playhead');
    if (!playhead) {
      playhead = document.createElement('div');
      playhead.id = 'score-live-playhead';
      playhead.className = 'score-live-playhead';
      surface.appendChild(playhead);
    }
    let beatHl = document.getElementById('score-live-beat-hl');
    if (!beatHl) {
      beatHl = document.createElement('div');
      beatHl.id = 'score-live-beat-hl';
      beatHl.className = 'score-live-beat-hl';
      surface.appendChild(beatHl);
    }
    return { playhead, beatHl };
  }

  function formatSecShort(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  }

  function updateLivePlayheadAndScroll(audioSec) {
    const scroller = document.getElementById('score-scroll-container');
    const readout = document.getElementById('score-bar-readout');
    if (!scroller) return;

    if (!mgr.renderedTimeline) {
      buildRenderedTimeline();
    }
    const tl = mgr.renderedTimeline;
    if (!tl || !tl.bars.length) return;

    const overlays = ensureLivePlayheadElements();
    if (!overlays) return;

    let targetSec = Math.max(0, (audioSec - mgr.currentBaseOnsetSec + mgr.offsetSec) * (mgr.currentTempoScale || 1.0));
    if (mgr.currentLoopRiff && tl.totalDurationSec > 0 && tl.totalDurationSec < 32) {
      targetSec = targetSec % tl.totalDurationSec;
    } else if (tl.totalDurationSec > 0) {
      targetSec = Math.min(tl.totalDurationSec - 0.01, targetSec);
    }

    const bars = tl.bars;
    let lo = 0, hi = bars.length - 1, barIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (targetSec < bars[mid].startSec) {
        hi = mid - 1;
      } else if (targetSec >= bars[mid].endSec) {
        barIdx = mid;
        lo = mid + 1;
      } else {
        barIdx = mid;
        break;
      }
    }

    const bar = bars[barIdx];
    let cursorX = bar.x + ((targetSec - bar.startSec) / Math.max(0.1, bar.durSec)) * bar.w;
    let activeBeat = null;

    if (bar.beats && bar.beats.length > 0) {
      let bi = 0;
      for (let i = 0; i < bar.beats.length; i++) {
        if (targetSec >= bar.beats[i].startSec) bi = i;
        else break;
      }
      activeBeat = bar.beats[bi];
      const nextBeat = bar.beats[bi + 1];
      const nextX = nextBeat ? nextBeat.noteX : (bar.x + bar.w - 4);
      const span = Math.max(0.05, activeBeat.endSec - activeBeat.startSec);
      const p = Math.max(0, Math.min(1, (targetSec - activeBeat.startSec) / span));
      cursorX = activeBeat.noteX + p * (nextX - activeBeat.noteX);
    }

    overlays.playhead.style.display = 'block';
    overlays.playhead.style.transform = `translate3d(${cursorX.toFixed(1)}px, ${(bar.y + 4).toFixed(1)}px, 0)`;
    overlays.playhead.style.height = `${Math.max(44, bar.h - 8).toFixed(1)}px`;

    if (activeBeat) {
      overlays.beatHl.style.display = 'block';
      overlays.beatHl.style.transform = `translate3d(${(activeBeat.noteX - 10).toFixed(1)}px, ${(bar.y + 6).toFixed(1)}px, 0)`;
      overlays.beatHl.style.width = '20px';
      overlays.beatHl.style.height = `${Math.max(40, bar.h - 12).toFixed(1)}px`;
    } else {
      overlays.beatHl.style.display = 'none';
    }

    if (readout) {
      readout.textContent = `C.${bar.index + 1} · ${formatSecShort(audioSec)}`;
    }

    if (Date.now() > mgr.userTouchHoldUntil) {
      const desiredLeft = Math.max(0, cursorX - scroller.clientWidth * 0.26);
      const diff = desiredLeft - scroller.scrollLeft;
      if (Math.abs(diff) > 180) {
        scroller.scrollLeft = desiredLeft;
      } else if (Math.abs(diff) > 1.5) {
        scroller.scrollLeft += diff * 0.35;
      }
    }
  }

  function stopSyncTicker() {
    if (mgr.syncTimer) {
      clearInterval(mgr.syncTimer);
      mgr.syncTimer = null;
    }
  }

  function startSyncTicker() {
    stopSyncTicker();
    mgr.syncTimer = setInterval(() => {
      if (!mgr.isPanelOpen || mgr.currentScoreMode === 'songsterr' || !mgr.api) return;
      try {
        const audioSec = typeof getSmoothAudioTimeSec === 'function' ? getSmoothAudioTimeSec() : 0;
        updateLivePlayheadAndScroll(audioSec);
      } catch (_) {}
    }, 40);
  }

  function getConfiguredStaveProfile() {
    if (typeof window.alphaTab === 'undefined' || !window.alphaTab.StaveProfile) return 3;
    return mgr.staveMode === 'tab' ? window.alphaTab.StaveProfile.Tab : window.alphaTab.StaveProfile.ScoreTab;
  }

  function buildAlphaTabSettingsObject() {
    const preset = SCORE_HEIGHTS[mgr.sizeIdx] || SCORE_HEIGHTS[1];
    const NE = window.alphaTab.NotationElement || {};
    const hidden = {};
    if (NE.ScoreTitle !== undefined) hidden[NE.ScoreTitle] = false;
    if (NE.ScoreSubTitle !== undefined) hidden[NE.ScoreSubTitle] = false;
    if (NE.ScoreArtist !== undefined) hidden[NE.ScoreArtist] = false;
    if (NE.ScoreAlbum !== undefined) hidden[NE.ScoreAlbum] = false;
    if (NE.ScoreWords !== undefined) hidden[NE.ScoreWords] = false;
    if (NE.ScoreMusic !== undefined) hidden[NE.ScoreMusic] = false;
    if (NE.ScoreWordsAndMusic !== undefined) hidden[NE.ScoreWordsAndMusic] = false;
    if (NE.ScoreCopyright !== undefined) hidden[NE.ScoreCopyright] = false;
    if (NE.GuitarTuning !== undefined) hidden[NE.GuitarTuning] = false;
    if (NE.ChordDiagrams !== undefined) hidden[NE.ChordDiagrams] = false;
    if (NE.TrackNames !== undefined) hidden[NE.TrackNames] = false;

    const rhythmModeVal = (window.alphaTab.TabRhythmMode && window.alphaTab.TabRhythmMode.ShowWithBars !== undefined)
      ? window.alphaTab.TabRhythmMode.ShowWithBars
      : 2;

    return {
      core: {
        useWorkers: false,
        fontDirectory: 'libs/alphatab/font/',
        engine: 'svg',
        enableLazyLoading: false
      },
      display: {
        layoutMode: window.alphaTab.LayoutMode.Horizontal,
        staveProfile: getConfiguredStaveProfile(),
        scale: preset.scale || 0.84,
        stretchForce: 0.92,
        padding: [2, 10, 2, 10],
        firstSystemPaddingTop: 6,
        systemPaddingTop: 4,
        systemPaddingBottom: 4,
        lastSystemPaddingBottom: 4,
        notationStaffPaddingTop: 2,
        notationStaffPaddingBottom: 2,
        resources: {
          staffLineColor: '#71717a',
          barSeparatorColor: '#a1a1aa',
          barNumberColor: '#9ca3af',
          mainGlyphColor: '#ffffff',
          secondaryGlyphColor: '#d4d4d8',
          scoreInfoColor: '#38bdf8',
          tablatureFont: '700 13px Arial, sans-serif'
        }
      },
      notation: {
        elements: hidden,
        rhythmMode: rhythmModeVal
      },
      player: {
        enablePlayer: false,
        enableCursor: false
      }
    };
  }

  function wireScrollerTouchAndClickSeek(scroller, surface) {
    if (!scroller || !surface || surface.dataset.seekWired === '1') return;
    surface.dataset.seekWired = '1';

    const holdManualScroll = () => {
      mgr.userTouchHoldUntil = Date.now() + 2600;
    };
    scroller.addEventListener('touchstart', (e) => {
      holdManualScroll();
      mgr.pointerMoved = false;
      if (e.touches && e.touches[0]) mgr.pointerDownX = e.touches[0].clientX;
    }, { passive: true });
    scroller.addEventListener('touchmove', (e) => {
      holdManualScroll();
      if (e.touches && e.touches[0] && Math.abs(e.touches[0].clientX - mgr.pointerDownX) > 10) {
        mgr.pointerMoved = true;
      }
    }, { passive: true });
    scroller.addEventListener('wheel', holdManualScroll, { passive: true });

    surface.addEventListener('click', (e) => {
      if (mgr.currentScoreMode === 'songsterr') return;
      if (mgr.pointerMoved || !mgr.renderedTimeline || !mgr.renderedTimeline.bars.length) return;
      const rect = surface.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const bars = mgr.renderedTimeline.bars;
      const hitBar = bars.find(b => clickX >= b.x && clickX <= b.x + b.w);
      if (!hitBar) return;
      const frac = Math.max(0, Math.min(1, (clickX - hitBar.x) / Math.max(1, hitBar.w)));
      const targetSec = ((hitBar.startSec + frac * hitBar.durSec) / (mgr.currentTempoScale || 1.0)) + mgr.currentBaseOnsetSec - mgr.offsetSec;
      mgr.userTouchHoldUntil = 0;
      if (typeof seekToSeconds === 'function') {
        seekToSeconds(Math.max(0, targetSec));
      }
    });
  }

  function ensureAlphaTabApi() {
    if (mgr.api) return mgr.api;
    if (typeof window.alphaTab === 'undefined') return null;

    const surface = document.getElementById('alphatab-surface');
    const scroller = document.getElementById('score-scroll-container');
    if (!surface || !scroller) return null;

    wireScrollerTouchAndClickSeek(scroller, surface);
    const api = new window.alphaTab.AlphaTabApi(surface, buildAlphaTabSettingsObject());

    api.scoreLoaded.on((score) => {
      try {
        mgr.renderedTimeline = null;
        populateTrackDropdown(score, mgr.activeTrackIdx);
      } catch (_) {}
    });

    api.renderFinished.on(() => {
      try {
        buildRenderedTimeline();
        ensureLivePlayheadElements();
        const audioSec = typeof getSmoothAudioTimeSec === 'function' ? getSmoothAudioTimeSec() : 0;
        updateLivePlayheadAndScroll(audioSec);
      } catch (_) {}
    });

    mgr.api = api;
    return api;
  }

  function applyStaveAndScaleToApi() {
    if (!mgr.api || typeof window.alphaTab === 'undefined' || mgr.currentScoreMode === 'songsterr') return;
    try {
      const preset = SCORE_HEIGHTS[mgr.sizeIdx] || SCORE_HEIGHTS[1];
      mgr.api.settings.display.layoutMode = window.alphaTab.LayoutMode.Horizontal;
      mgr.api.settings.display.staveProfile = getConfiguredStaveProfile();
      mgr.api.settings.display.scale = preset.scale || 0.84;
      mgr.renderedTimeline = null;
      mgr.api.updateSettings();
      mgr.api.render();
    } catch (_) {}
  }

  function populateTrackDropdown(score, selectedIdx = 0) {
    const sel = document.getElementById('score-track-select');
    const btnCycle = document.getElementById('btn-score-track-cycle');
    if (!score || !Array.isArray(score.tracks) || score.tracks.length <= 1 || mgr.currentScoreMode === 'songsterr') {
      if (sel) sel.style.display = 'none';
      if (btnCycle) btnCycle.style.display = 'none';
      return;
    }
    const clamped = Math.max(0, Math.min(score.tracks.length - 1, Number(selectedIdx) || 0));
    if (sel) {
      sel.style.display = 'inline-block';
      sel.innerHTML = '';
      score.tracks.forEach((tr, idx) => {
        const st = tr.staves && tr.staves[0];
        const nStr = (st && st.stringTuning && st.stringTuning.tunings && st.stringTuning.tunings.length) || 0;
        const strSuffix = nStr > 0 ? ` (${nStr}C)` : '';
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = (tr.name ? tr.name.trim() : `Inst ${idx + 1}`) + strSuffix;
        sel.appendChild(opt);
      });
      sel.value = String(clamped);
    }
    if (btnCycle) {
      const curTr = score.tracks[clamped];
      const curName = (curTr && curTr.name ? curTr.name.trim() : `Inst ${clamped + 1}`).slice(0, 14);
      btnCycle.style.display = 'inline-flex';
      btnCycle.textContent = `🎸 ${clamped + 1}/${score.tracks.length} · ${curName}`;
      btnCycle.title = `Cambiar instrumento (${clamped + 1}/${score.tracks.length})`;
    }
  }

  function applyPanelSize() {
    const panel = document.getElementById('score-split-panel');
    const sizeBtn = document.getElementById('btn-score-size');
    const staveBtn = document.getElementById('btn-score-stave');
    const preset = SCORE_HEIGHTS[mgr.sizeIdx] || SCORE_HEIGHTS[1];
    if (panel) panel.style.height = preset.css;
    if (sizeBtn) sizeBtn.textContent = preset.key;
    if (staveBtn) staveBtn.textContent = mgr.staveMode === 'tab' ? 'Pent+Tab' : '6 Cuerdas';
    if (mgr.isNativeSplitOpen) {
      requestAnimationFrame(() => syncNativeDockedRect());
      if (window.AndroidBridge && typeof window.AndroidBridge.setSongsterrSplitHeight === 'function') {
        window.AndroidBridge.setSongsterrSplitHeight(preset.nativePct);
      }
    }
  }

  function hideNativeSongsterrOverlayOnly() {
    if (mgr.isNativeSplitOpen) {
      mgr.isNativeSplitOpen = false;
      if (window.AndroidBridge && typeof window.AndroidBridge.hideSongsterrSplit === 'function') {
        try { window.AndroidBridge.hideSongsterrSplit(); } catch (_) {}
      }
    }
  }

  async function openRealAlphaTab(song, info) {
    const panel = document.getElementById('score-split-panel');
    const badge = document.getElementById('score-source-badge');
    const banner = document.getElementById('score-status-banner');
    const surface = document.getElementById('alphatab-surface');
    if (!panel) return;

    hideNativeSongsterrOverlayOnly();
    mgr.isPanelOpen = true;
    saveOpenPref(true);
    panel.style.display = 'flex';
    if (surface) surface.style.visibility = 'visible';
    if (banner) banner.style.display = 'none';
    applyPanelSize();
    configureToolbarForMode('alphatab', info);

    const api = ensureAlphaTabApi();
    if (!api) {
      if (banner) {
        banner.style.display = 'flex';
        banner.textContent = 'Cargando motor de tablatura 6 cuerdas...';
      }
      return;
    }

    // 1. Archivo .gp/.gp5 importado por el usuario
    if (info.hasCustom) {
      const rec = await getCustomGpFile(info.customSongKey);
      if (rec && rec.bytes) {
        mgr.currentScoreMode = 'customGp';
        mgr.currentBaseOnsetSec = info.gpOffsetSec || info.onsetSec || 0;
        mgr.currentTempoScale = info.gpTempoScale || 1.0;
        mgr.currentLoopRiff = false;
        mgr.activeTrackIdx = 0;
        const loadKey = `gp:${info.customSongKey}:${rec.savedAt}`;
        if (badge) badge.textContent = '🎸 Tab';
        if (mgr.lastLoadedKey !== loadKey) {
          mgr.lastLoadedKey = loadKey;
          mgr.renderedTimeline = null;
          api.load(new Uint8Array(rec.bytes), [0]);
        }
        startSyncTicker();
        updateToggleButtonForSong(song);
        return;
      }
    }

    // 2. Tablatura editada y marcada como "Lista" en Estación 3 del Editor
    if (info.hasLiveEditorTab) {
      const liveTex = `\\tempo 120\n\\tuning E4 B3 G3 D3 A2 E2\n.\n${info.liveTabBars.join(' | ')}`;
      mgr.currentScoreMode = 'asciiRiff';
      mgr.currentBaseOnsetSec = info.gpOffsetSec || info.tabStartSec || 0;
      mgr.currentTempoScale = info.gpTempoScale || 1.0;
      mgr.currentLoopRiff = false;
      mgr.activeTrackIdx = 0;
      const loadKey = `edtab:${song.id}:${liveTex.length}`;
      if (badge) badge.textContent = '🎸 Tab';
      if (mgr.lastLoadedKey !== loadKey) {
        mgr.lastLoadedKey = loadKey;
        mgr.renderedTimeline = null;
        api.tex(liveTex, [0]);
      }
      startSyncTicker();
      updateToggleButtonForSong(song);
      return;
    }

    // 3. Partitura Guitar Pro real multipista validada (real_gp_alphatex.json)
    if (info.hasRealGp && info.gpTex) {
      mgr.currentScoreMode = 'realGp';
      mgr.currentBaseOnsetSec = info.gpOffsetSec || info.onsetSec || 0;
      mgr.currentTempoScale = info.gpTempoScale || 1.0;
      mgr.currentLoopRiff = false;
      mgr.activeTrackIdx = info.gpTrack || 0;
      const loadKey = `realgp:${song.id}:${mgr.activeTrackIdx}`;
      if (badge) badge.textContent = '🎸 Tab';
      if (mgr.lastLoadedKey !== loadKey) {
        mgr.lastLoadedKey = loadKey;
        mgr.renderedTimeline = null;
        try {
          const imp = new window.alphaTab.importer.AlphaTexImporter();
          imp.initFromString(info.gpTex, api.settings);
          const score = imp.readScore();
          const trIdx = Math.max(0, Math.min(score.tracks.length - 1, mgr.activeTrackIdx));
          mgr.activeTrackIdx = trIdx;
          populateTrackDropdown(score, trIdx);
          api.renderScore(score, [trIdx]);
        } catch (_) {
          await openDockedSongsterr(song, info);
          return;
        }
        const scroller = document.getElementById('score-scroll-container');
        if (scroller) scroller.scrollLeft = 0;
      }
      startSyncTicker();
      updateToggleButtonForSong(song);
      return;
    }

    // 4. Tab ASCII real de 6 cuerdas del Cancionero (mínimo 4 compases, sin bucle artificial)
    if (info.hasAsciiRiff && info.tabTex) {
      mgr.currentScoreMode = 'asciiRiff';
      mgr.currentBaseOnsetSec = info.gpOffsetSec || info.tabStartSec || 0;
      mgr.currentTempoScale = info.gpTempoScale || 1.0;
      mgr.currentLoopRiff = false;
      mgr.activeTrackIdx = 0;
      const loadKey = `riff:${song.id}`;
      if (badge) badge.textContent = '🎸 Tab';
      if (mgr.lastLoadedKey !== loadKey) {
        mgr.lastLoadedKey = loadKey;
        mgr.renderedTimeline = null;
        api.tex(info.tabTex, [0]);
        const scroller = document.getElementById('score-scroll-container');
        if (scroller) scroller.scrollLeft = 0;
      }
      startSyncTicker();
      updateToggleButtonForSong(song);
      return;
    }

    await openDockedSongsterr(song, info);
  }

  async function openPreferredScoreView(song, info) {
    if (!song || !info) return;
    const mode = resolvePreferredMode(info);
    if (mode === 'alphatab' && info.hasLocalRealTab) {
      await openRealAlphaTab(song, info);
    } else {
      await openDockedSongsterr(song, info);
    }
  }

  function closeAllScoreViews(keepNativeState = false, preservePref = false) {
    mgr.isPanelOpen = false;
    mgr.currentScoreMode = null;
    if (!preservePref) saveOpenPref(false);
    stopSyncTicker();
    const panel = document.getElementById('score-split-panel');
    if (panel) panel.style.display = 'none';
    if (!keepNativeState) {
      hideNativeSongsterrOverlayOnly();
    }
    if (mgr.currentSong) updateToggleButtonForSong(mgr.currentSong);
  }

  async function toggle() {
    const song = mgr.currentSong || (typeof state !== 'undefined' && state.currentSong);
    if (!song) return;

    if (mgr.isPanelOpen || mgr.isNativeSplitOpen) {
      closeAllScoreViews(false, false);
      return;
    }

    const info = getSongScoreInfo(song);
    if (!info) return;
    await openPreferredScoreView(song, info);
  }

  async function onSongChanged(song) {
    mgr.currentSong = song;
    mgr.offsetSec = 0;
    mgr.lastLoadedKey = '';
    mgr.forcedModeForCurrentSong = null;
    mgr.userTouchHoldUntil = 0;
    updateToggleButtonForSong(song);

    if (song && !getStaticScoreMeta(song)) {
      discoverLiveSongsterrIfNeeded(song).then((found) => {
        if (found && mgr.currentSong && mgr.currentSong.id === song.id) {
          updateToggleButtonForSong(song);
          if (typeof renderDrawerList === 'function') renderDrawerList();
        }
      });
    }

    let wantOpen = mgr.isPanelOpen || mgr.isNativeSplitOpen;
    if (!wantOpen) {
      try { wantOpen = localStorage.getItem(PREF_OPEN_KEY) === '1'; } catch (_) {}
    }
    if (!wantOpen) return;

    const info = getSongScoreInfo(song);
    if (!info) {
      closeAllScoreViews(false, true);
      return;
    }
    await openPreferredScoreView(song, info);
  }

  function refreshCurrentSongIfOpen() {
    if (!mgr.isPanelOpen || !mgr.currentSong) return;
    mgr.lastLoadedKey = '';
    const info = getSongScoreInfo(mgr.currentSong);
    if (info) openPreferredScoreView(mgr.currentSong, info);
  }

  function promptGpImport(targetSong = null) {
    const s = targetSong || mgr.currentSong || (typeof state !== 'undefined' && state.currentSong);
    if (!s) {
      if (typeof showToast === 'function') showToast('Selecciona una canción primero', 'warn', 2000);
      return;
    }
    mgr.pendingFileSongId = s.id;
    const inp = document.getElementById('input-score-gp-file');
    if (inp) {
      inp.value = '';
      inp.click();
    }
  }

  function setupLayoutAndOverlayObservers() {
    if (typeof ResizeObserver !== 'undefined' && !mgr.resizeObs) {
      mgr.resizeObs = new ResizeObserver(() => {
        if (mgr.isNativeSplitOpen) syncNativeDockedRect();
      });
      for (const id of ['score-scroll-container', 'sheet-viewport', 'player-bar']) {
        const el = document.getElementById(id);
        if (el) mgr.resizeObs.observe(el);
      }
    }
    window.addEventListener('resize', () => {
      if (mgr.isNativeSplitOpen) syncNativeDockedRect();
    });

    if (typeof MutationObserver !== 'undefined' && !mgr.overlayObs) {
      mgr.overlayObs = new MutationObserver(() => {
        syncOverlayVisibilityWithNative();
        if (mgr.isNativeSplitOpen) syncNativeDockedRect();
      });
      for (const id of ['songs-drawer', 'embedded-editor-overlay', 'modal-manual-match', 'modal-upload', 'modal-apple-artist', 'modal-share-marks', 'player-bar']) {
        const el = document.getElementById(id);
        if (el) {
          mgr.overlayObs.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
        }
      }
    }
  }

  function init() {
    loadLiveCache();
    refreshCustomGpKeys();
    setupLayoutAndOverlayObservers();

    window.onNativeScoreSplitClosed = () => {
      mgr.isNativeSplitOpen = false;
      closeAllScoreViews(true, false);
    };

    const btnToggle = document.getElementById('btn-toggle-score-panel');
    if (btnToggle) btnToggle.addEventListener('click', toggle);

    const btnToggleExp = document.getElementById('btn-toggle-score-panel-exp');
    if (btnToggleExp) btnToggleExp.addEventListener('click', toggle);

    const btnHide = document.getElementById('btn-score-hide');
    if (btnHide) btnHide.addEventListener('click', () => closeAllScoreViews(false, false));

    const btnSize = document.getElementById('btn-score-size');
    if (btnSize) {
      btnSize.addEventListener('click', () => {
        mgr.sizeIdx = (mgr.sizeIdx + 1) % SCORE_HEIGHTS.length;
        try { localStorage.setItem(PREF_SIZE_KEY, String(mgr.sizeIdx)); } catch (_) {}
        applyPanelSize();
        applyStaveAndScaleToApi();
      });
    }

    const btnStave = document.getElementById('btn-score-stave');
    if (btnStave) {
      btnStave.addEventListener('click', () => {
        mgr.staveMode = mgr.staveMode === 'tab' ? 'scoreTab' : 'tab';
        try { localStorage.setItem(PREF_STAVE_KEY, mgr.staveMode); } catch (_) {}
        applyPanelSize();
        applyStaveAndScaleToApi();
      });
    }

    const btnModeSwitch = document.getElementById('btn-score-mode-switch');
    if (btnModeSwitch) {
      btnModeSwitch.addEventListener('click', () => {
        const s = mgr.currentSong || (typeof state !== 'undefined' && state.currentSong);
        if (!s) return;
        const info = getSongScoreInfo(s);
        openExternalSongsterr(s, info);
      });
    }

    const btnReloadSt = document.getElementById('btn-score-reload-st');
    if (btnReloadSt) {
      btnReloadSt.addEventListener('click', () => {
        if (window.AndroidBridge && typeof window.AndroidBridge.reloadSongsterrSplit === 'function') {
          window.AndroidBridge.reloadSongsterrSplit();
        }
      });
    }

    const btnMinus = document.getElementById('btn-score-offset-minus');
    if (btnMinus) {
      btnMinus.addEventListener('click', () => {
        mgr.offsetSec = +(mgr.offsetSec - 0.5).toFixed(1);
        if (typeof showToast === 'function') showToast(`Desfase tablatura: ${mgr.offsetSec > 0 ? '+' : ''}${mgr.offsetSec}s`, 'info', 1400);
      });
    }

    const btnPlus = document.getElementById('btn-score-offset-plus');
    if (btnPlus) {
      btnPlus.addEventListener('click', () => {
        mgr.offsetSec = +(mgr.offsetSec + 0.5).toFixed(1);
        if (typeof showToast === 'function') showToast(`Desfase tablatura: ${mgr.offsetSec > 0 ? '+' : ''}${mgr.offsetSec}s`, 'info', 1400);
      });
    }

    const btnImport = document.getElementById('btn-score-import-gp');
    if (btnImport) btnImport.addEventListener('click', () => promptGpImport());

    const btnDrawerGp = document.getElementById('btn-drawer-import-gp');
    if (btnDrawerGp) {
      btnDrawerGp.addEventListener('click', () => {
        if (typeof closeDrawer === 'function') closeDrawer();
        promptGpImport();
      });
    }

    const trackSel = document.getElementById('score-track-select');
    if (trackSel) {
      trackSel.addEventListener('change', () => {
        if (!mgr.api || !mgr.api.score) return;
        const idx = parseInt(trackSel.value, 10);
        const tr = mgr.api.score.tracks[idx];
        if (tr) {
          mgr.activeTrackIdx = idx;
          mgr.renderedTimeline = null;
          populateTrackDropdown(mgr.api.score, idx);
          mgr.api.renderTracks([tr]);
        }
      });
    }

    const btnTrackCycle = document.getElementById('btn-score-track-cycle');
    if (btnTrackCycle) {
      btnTrackCycle.addEventListener('click', () => {
        if (!mgr.api || !mgr.api.score || !Array.isArray(mgr.api.score.tracks) || mgr.api.score.tracks.length <= 1) return;
        const nextIdx = ((mgr.activeTrackIdx || 0) + 1) % mgr.api.score.tracks.length;
        const tr = mgr.api.score.tracks[nextIdx];
        if (tr) {
          mgr.activeTrackIdx = nextIdx;
          mgr.renderedTimeline = null;
          populateTrackDropdown(mgr.api.score, nextIdx);
          mgr.api.renderTracks([tr]);
          if (typeof showToast === 'function') {
            showToast(`🎸 Instrumento ${nextIdx + 1}/${mgr.api.score.tracks.length}: ${tr.name || 'Pista'}`, 'info', 1800);
          }
        }
      });
    }

    const fileInput = document.getElementById('input-score-gp-file');
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const songId = mgr.pendingFileSongId || (mgr.currentSong && mgr.currentSong.id);
        if (!songId) return;
        try {
          await saveCustomGpFile(songId, file);
          mgr.lastLoadedKey = '';
          mgr.forcedModeForCurrentSong = 'alphatab';
          if (typeof showToast === 'function') showToast(`Partitura "${file.name}" vinculada y lista`, 'success', 2500);
          const s = mgr.currentSong || (typeof state !== 'undefined' && state.currentSong);
          if (s && s.id === songId) {
            const info = getSongScoreInfo(s);
            if (info) await openRealAlphaTab(s, info);
          }
        } catch (err) {
          if (typeof showToast === 'function') showToast('Error cargando archivo de partitura: ' + (err.message || err), 'warn', 3000);
        }
      });
    }
  }

  mgr.init = init;
  mgr.toggle = toggle;
  mgr.hide = () => closeAllScoreViews(false, false);
  mgr.onSongChanged = onSongChanged;
  mgr.refreshCurrentSongIfOpen = refreshCurrentSongIfOpen;
  mgr.getSongScoreInfo = getSongScoreInfo;
  mgr.promptGpImport = promptGpImport;

  window.ScoreSplitManager = mgr;
})();
