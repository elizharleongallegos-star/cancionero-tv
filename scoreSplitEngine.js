/**
 * @file scoreSplitEngine.js
 * @description Motor SSoT de Tablatura de 6 Cuerdas (estilo Songsterr Oscuro) Sincronizada 1:1 con la Playlist:
 *  - Modo A (Tablatura 6 Cuerdas en 1 Línea Sincronizada con Playlist): Renderiza en LayoutMode.Horizontal
 *    las 6 líneas horizontales de las cuerdas (StaveProfile.Tab + TabRhythmMode.ShowWithBars), números de compás,
 *    trastes blancos sobre fondo oscuro estilo Songsterr y plicas rítmicas debajo, avanzando nota por nota
 *    en paralelo con el reproductor de YouTube mediante boundsLookup exacto + cursor en vivo.
 *  - Modo B (Songsterr Oficial): Permite abrir la vista nativa oficial de Songsterr con cuenta básica.
 */

(function () {
  const DB_NAME = 'cancionero_scores_v1';
  const STORE_NAME = 'gp_files';
  const LIVE_CACHE_KEY = 'songsterr_live_cache_v1';
  const PREF_OPEN_KEY = 'cancionero_score_strip_open_v1';
  const PREF_STAVE_KEY = 'cancionero_score_stave_v2'; // v2: 6 cuerdas (StaveProfile.Tab) por defecto

  const SCORE_HEIGHTS = [
    { key: '1L', css: '148px', nativePct: 30, scale: 0.72 },
    { key: 'M', css: '176px', nativePct: 38, scale: 0.84 },
    { key: 'L', css: '216px', nativePct: 48, scale: 0.96 }
  ];

  const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_TO_SHARP = { DB: 'C#', EB: 'D#', GB: 'F#', AB: 'G#', BB: 'A#', CB: 'B', FB: 'E' };
  const STANDARD_TUNING = [64, 59, 55, 50, 45, 40]; // 1:E4, 2:B3, 3:G3, 4:D3, 5:A2, 6:E2
  const DROP_D_TUNING = [64, 59, 55, 50, 45, 38];

  function midiToAlphaPitch(midi) {
    const m = Math.max(24, Math.min(84, Math.round(Number(midi) || 40)));
    const oct = Math.floor(m / 12) - 1;
    return CHROMATIC[m % 12] + oct;
  }

  function resolveTuningArray(chart) {
    if (chart && Array.isArray(chart.tn) && chart.tn.length === 6) {
      return chart.tn.map(n => Number(n) || 40);
    }
    return (chart && chart.dd) ? DROP_D_TUNING : STANDARD_TUNING;
  }

  function parseChordInfo(chordName) {
    const clean = String(chordName || 'G5').replace(/\/.*$/, '').trim();
    const m = clean.match(/^([A-G])(#|b)?(m|maj|min|dim|aug|sus|add|M)?([0-9]*)/);
    if (!m) return { pitchClass: 7, isMinor: false, isPower: true };
    let root = m[1].toUpperCase() + (m[2] || '');
    if (FLAT_TO_SHARP[root]) root = FLAT_TO_SHARP[root];
    const pc = CHROMATIC.indexOf(root);
    const qual = (m[3] || '') + (m[4] || '');
    const isPower = /^5$/.test(qual);
    const isMinor = /^m(?!aj)/.test(qual) || /min|dim/.test(qual);
    return { pitchClass: pc >= 0 ? pc : 7, isMinor, isPower };
  }

  /**
   * Genera un compás 4/4 de tablatura de 6 cuerdas con notas individuales / octavas / quintas
   * en corcheas (.8) y negras (.4) estilo Songsterr (con plicas rítmicas debajo).
   */
  function chordToSongsterrBar(chordName, barIdx, sectionKind, tuningArr) {
    const { pitchClass, isMinor, isPower } = parseChordInfo(chordName);
    const open6 = (tuningArr[5] || 40) % 12;
    const open5 = (tuningArr[4] || 45) % 12;
    const open4 = (tuningArr[3] || 50) % 12;
    const isDrop = ((open5 - open6 + 12) % 12) === 7; // ej. Drop D / Drop C#

    const fret6 = (pitchClass - open6 + 12) % 12;
    const fret5 = (pitchClass - open5 + 12) % 12;
    const fret4 = (pitchClass - open4 + 12) % 12;

    // Elegir cuerda base cómoda (cuerda 6 si traste <= 7, cuerda 5 si <= 9, cuerda 4 para riffs agudos)
    if (sectionKind === 'intro' || sectionKind === 'solo') {
      // Riff melódico estilo Songsterr sobre cuerdas 4, 3 y 2 (como referencia visual compases 14-15)
      const r4 = fret4 <= 10 ? fret4 : Math.max(0, fret4 - 12);
      const fifth4 = Math.min(22, r4 + 7);
      const pass4 = Math.min(22, fifth4 + 2);
      const oct3 = Math.min(22, r4 + 7 - 5 + 5); // en cuerda 3: +5 semitonos respecto a cuerda 4 => octava = r4 + 7, 5ta = r4 + 2
      const note3a = Math.min(22, r4 + 5);
      const note3b = Math.min(22, note3a + (isMinor ? 2 : 2));
      const note2 = Math.min(22, r4 + (isMinor ? 3 : 4));
      if (barIdx % 2 === 0) {
        return `${r4}.4.8 ${fifth4}.4.8 ${pass4}.4.8 ${fifth4}.4.8 ${note3a}.3.8 ${note3b}.3.4 ${note2}.2.8`;
      }
      const step3 = Math.max(0, note3a - 1);
      return `${r4}.4.8 ${fifth4}.4.8 ${pass4}.4.8 ${fifth4}.4.8 ${note3a}.3.8 ${step3}.3.8 ${pass4}.4.8 ${fifth4}.4.8`;
    }

    const useStr5 = (!isDrop && fret6 > 7) || (fret5 <= 7 && (barIdx % 4 >= 2) && fret6 > 3);
    const sRoot = useStr5 ? 5 : 6;
    const r = useStr5 ? fret5 : fret6;
    const s5th = sRoot - 1;
    const f5 = (sRoot === 6 && isDrop) ? r : (r + 2);
    const sOct = sRoot - 2;
    const fOct = (sRoot === 6 && isDrop) ? (r + 2) : (r + 2);
    const s3rd = Math.max(1, sRoot - 3);
    // Ajuste intervalo cuerda 3->2 (4 semitonos en vez de 5)
    const thirdShift = s3rd === 2 ? (isMinor ? 1 : 2) : (isMinor ? 0 : 1);
    const f3rd = Math.max(0, Math.min(22, r + thirdShift));
    const fPass = Math.min(22, fOct + 2);

    if (sectionKind === 'chorus' || isPower) {
      // Coro / quintas con pulso rítmico de rock en corcheas + octavas
      if (barIdx % 2 === 0) {
        return `(${r}.${sRoot} ${f5}.${s5th}).8 ${r}.${sRoot}.8 ${r}.${sRoot}.8 (${r}.${sRoot} ${f5}.${s5th} ${fOct}.${sOct}).8 ${r}.${sRoot}.8 ${fOct}.${sOct}.8 ${fPass}.${sOct}.8 ${fOct}.${sOct}.8`;
      }
      return `(${r}.${sRoot} ${f5}.${s5th}).8 ${r}.${sRoot}.8 ${f5}.${s5th}.8 ${fOct}.${sOct}.8 ${fPass}.${sOct}.8 ${fOct}.${sOct}.8 (${r}.${sRoot} ${f5}.${s5th}).4`;
    }

    // Verso / Puente: arpegio limpio y movimiento en las 6 cuerdas (8 corcheas por compás)
    if (barIdx % 2 === 0) {
      return `${r}.${sRoot}.8 ${f5}.${s5th}.8 ${fOct}.${sOct}.8 ${f3rd}.${s3rd}.8 ${fOct}.${sOct}.8 ${f5}.${s5th}.8 ${f3rd}.${s3rd}.8 ${fOct}.${sOct}.8`;
    }
    return `${r}.${sRoot}.8 ${f5}.${s5th}.8 ${fOct}.${sOct}.8 ${fPass}.${sOct}.8 ${f3rd}.${s3rd}.8 ${fOct}.${sOct}.8 ${f5}.${s5th}.8 ${r}.${sRoot}.8`;
  }

  /**
   * Convierte bloques ASCII editados en vivo (ej. desde Estación 3 del Editor) en compases AlphaTex de 6 cuerdas.
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
    return outBars.slice(0, 32);
  }

  function classifySectionKind(secLabel, barIdx) {
    const s = String(secLabel || '').toLowerCase();
    if (/intro|riff|punteo|solo|inter/.test(s)) return 'intro';
    if (/coro|estribillo|final|outro/.test(s)) return 'chorus';
    if (/verso|estrofa|puente|pre/.test(s)) return 'verse';
    return barIdx < 4 ? 'intro' : 'verse';
  }

  function expandCompactChartToAlphaTex(chart, liveEditedTabBars = null) {
    if (!chart || !Array.isArray(chart.ev) || chart.ev.length === 0) return null;
    const totalBars = Math.max(16, Math.min(360, Number(chart.b) || 105));
    const tuningArr = resolveTuningArray(chart);
    const evMap = new Map();
    for (const item of chart.ev) {
      if (Array.isArray(item) && item.length >= 2) {
        evMap.set(Number(item[0]), { ch: String(item[1] || 'G5'), sec: item[2] ? String(item[2]) : '' });
      }
    }

    const riffBars = (Array.isArray(liveEditedTabBars) && liveEditedTabBars.length > 0)
      ? liveEditedTabBars
      : (Array.isArray(chart.rb) ? chart.rb : []);
    const riffStartBar = Math.max(0, Number(chart.rbs) || 0);

    let activeChord = (chart.ev[0] && chart.ev[0][1]) || 'G5';
    let activeSectionKind = 'intro';
    let lastShownChord = '';
    const bars = [];

    for (let b = 0; b < totalBars; b++) {
      const ev = evMap.get(b);
      let chordLabel = '';
      let secCmd = '';
      if (ev) {
        activeChord = ev.ch;
        if (ev.sec) {
          const safeSec = ev.sec.replace(/"/g, '').slice(0, 18);
          secCmd = `\\section "${safeSec}" `;
          activeSectionKind = classifySectionKind(safeSec, b);
        } else if (b >= 4 && activeSectionKind === 'intro') {
          activeSectionKind = 'verse';
        }
        if (activeChord !== lastShownChord || secCmd) {
          const safeCh = activeChord.replace(/"/g, '');
          chordLabel = ` {ch "${safeCh}"}`;
          lastShownChord = activeChord;
        }
      } else {
        if (b === 0) {
          chordLabel = ` {ch "${activeChord.replace(/"/g, '')}"}`;
          lastShownChord = activeChord;
        } else if (b === 4 && activeSectionKind === 'intro') {
          activeSectionKind = 'verse';
        }
      }

      // Si hay tablatura ASCII real para este compás (Intro / Riff / Editada), insertarla directamente
      const relRiffIdx = b - riffStartBar;
      if (riffBars.length > 0 && relRiffIdx >= 0 && relRiffIdx < riffBars.length) {
        const rbStr = riffBars[relRiffIdx];
        if (chordLabel) {
          const firstSpace = rbStr.indexOf(' ');
          if (firstSpace > 0) {
            bars.push(`${secCmd}${rbStr.slice(0, firstSpace)}${chordLabel}${rbStr.slice(firstSpace)}`);
          } else {
            bars.push(`${secCmd}${rbStr}${chordLabel}`);
          }
        } else {
          bars.push(`${secCmd}${rbStr}`);
        }
        continue;
      }

      const generated = chordToSongsterrBar(activeChord, b, activeSectionKind, tuningArr);
      if (chordLabel) {
        const firstSpace = generated.indexOf(' ');
        if (firstSpace > 0) {
          bars.push(`${secCmd}${generated.slice(0, firstSpace)}${chordLabel}${generated.slice(firstSpace)}`);
        } else {
          bars.push(`${secCmd}${generated}${chordLabel}`);
        }
      } else {
        bars.push(`${secCmd}${generated}`);
      }
    }

    const tuningLine = '\\tuning ' + tuningArr.map(midiToAlphaPitch).join(' ');
    return `\\tempo 120\n${tuningLine}\n.\n${bars.join(' | ')}`;
  }

  const mgr = {
    isPanelOpen: false,
    isNativeSplitOpen: false,
    sizeIdx: 0, // '1L' por defecto (6 cuerdas arriba del reproductor)
    staveMode: 'tab', // 'tab' (6 cuerdas estilo Songsterr) | 'scoreTab' (Pentagrama + Tab)
    preferRiffMode: false,
    api: null,
    currentSong: null,
    currentScoreMode: null, // 'customGp' | 'alphaTex' | 'songsterr'
    currentChartFullSync: true,
    offsetSec: 0,
    syncTimer: null,
    suppressHostMedia: false,
    lastLoadedKey: '',
    renderedTimeline: null,
    userTouchHoldUntil: 0,
    pointerDownX: 0,
    pointerMoved: false,
    customGpIndexSet: new Set(),
    liveSongsterrCache: {},
    pendingFileSongId: null
  };

  try {
    const savedStave = localStorage.getItem(PREF_STAVE_KEY);
    if (savedStave === 'tab' || savedStave === 'scoreTab') mgr.staveMode = savedStave;
  } catch (_) {}

  function normText(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
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
    const hasTabTex = !!(meta && meta.tex) || liveTabBars.length > 0;
    let chart = (meta && meta.c && Array.isArray(meta.c.ev) && meta.c.ev.length > 0) ? meta.c : null;
    if (!chart) {
      chart = {
        b: Math.max(24, Math.ceil(((typeof state !== 'undefined' && state.durationSec) || 200) / 2.0)),
        dd: 0,
        ev: [[0, song.tone || 'Am', 'Inicio']]
      };
    }
    const songsterrId = meta && meta.sid ? meta.sid : null;

    return {
      hasCustom,
      customSongKey: mgr.customGpIndexSet.has(song.id) ? song.id : sidKey,
      hasTabTex,
      tabTex: (meta && meta.tex) ? meta.tex : null,
      liveTabBars,
      tabStartSec: (meta && Number(meta.tabStartSec)) || 0,
      hasChart: true,
      chart,
      songsterrId,
      songsterrUrl: songsterrId ? `https://www.songsterr.com/a/wa/song?id=${songsterrId}` : null,
      tracks: (meta && meta.tr) || [],
      artist: (meta && meta.a) || song.artist || '',
      title: (meta && meta.t) || song.title || ''
    };
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
      btn.classList.toggle('has-gp-sync', true);
      const lbl = btn.querySelector('.score-pill-label-text') || (btn.id === 'btn-toggle-score-panel' ? document.getElementById('score-pill-label') : null);
      if (lbl) {
        if (active) {
          lbl.textContent = 'Tab ▲';
        } else if (info.hasCustom) {
          lbl.textContent = 'Tab .gp';
        } else {
          lbl.textContent = 'Tab 6C';
        }
      }
      btn.title = active
        ? 'Ocultar tablatura de 6 cuerdas'
        : 'Mostrar tablatura de 6 cuerdas sincronizada con la playlist';
    }
  }

  async function discoverLiveSongsterrIfNeeded(song) {
    if (!song || !song.artist || !song.title) return;
    const existing = getStaticScoreMeta(song);
    if (existing && existing.sid) return;
    if (mgr.liveSongsterrCache[song.id] !== undefined) return;
    if (!window.AndroidBridge || typeof window.AndroidBridge.httpGet !== 'function') return;

    try {
      const url = 'https://www.songsterr.com/api/songs?pattern=' + encodeURIComponent(`${song.artist} ${song.title}`) + '&size=25';
      const raw = window.AndroidBridge.httpGet(url);
      if (!raw) {
        mgr.liveSongsterrCache[song.id] = null;
        saveLiveCache();
        return;
      }
      const list = JSON.parse(raw);
      const targetTitle = normText(song.title);
      const hit = Array.isArray(list) ? list.find(item => {
        const it = normText(item.title);
        return it === targetTitle || (targetTitle.length >= 5 && (it.includes(targetTitle) || targetTitle.includes(it)));
      }) : null;

      if (hit) {
        mgr.liveSongsterrCache[song.id] = {
          ...(existing || {}),
          sid: hit.songId,
          a: hit.artist,
          t: hit.title,
          tr: (hit.tracks || []).slice(0, 4).map(t => ({ n: t.name || t.instrument, i: t.instrument }))
        };
        saveLiveCache();
      }
    } catch (_) {}
  }

  /**
   * Construye mapa exacto de tiempos (segundos) y coordenadas X (píxeles) de cada compás y cada pulso/nota
   * a partir de api.renderer.boundsLookup + api.score.masterBars.
   */
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

    let targetSec = Math.max(0, audioSec + mgr.offsetSec);
    if (mgr.currentScoreMode === 'alphaTex' && !mgr.currentChartFullSync && tl.totalDurationSec > 0) {
      const info = getSongScoreInfo(mgr.currentSong);
      const tabStart = (info && info.tabStartSec) || 0;
      targetSec = Math.max(0, audioSec - tabStart + mgr.offsetSec) % tl.totalDurationSec;
    } else if (tl.totalDurationSec > 0) {
      targetSec = Math.min(tl.totalDurationSec - 0.01, targetSec);
    }

    // Búsqueda binaria del compás activo
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
      readout.textContent = `C.${bar.index + 1} · ${formatSecShort(targetSec)}`;
    }

    // Auto-scroll horizontal suave siguiendo la nota activa (si el usuario no está arrastrando manualmente)
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
      if (!mgr.isPanelOpen || !mgr.api) return;
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
    const preset = SCORE_HEIGHTS[mgr.sizeIdx] || SCORE_HEIGHTS[0];
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
        scale: preset.scale || 0.72,
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
      if (mgr.pointerMoved || !mgr.renderedTimeline || !mgr.renderedTimeline.bars.length) return;
      const rect = surface.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const bars = mgr.renderedTimeline.bars;
      const hitBar = bars.find(b => clickX >= b.x && clickX <= b.x + b.w);
      if (!hitBar) return;
      const frac = Math.max(0, Math.min(1, (clickX - hitBar.x) / Math.max(1, hitBar.w)));
      let targetSec = hitBar.startSec + frac * hitBar.durSec - mgr.offsetSec;
      if (mgr.currentScoreMode === 'alphaTex' && !mgr.currentChartFullSync) {
        const info = getSongScoreInfo(mgr.currentSong);
        targetSec += (info && info.tabStartSec) || 0;
      }
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
        populateTrackDropdown(score);
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
    if (!mgr.api || typeof window.alphaTab === 'undefined') return;
    try {
      const preset = SCORE_HEIGHTS[mgr.sizeIdx] || SCORE_HEIGHTS[0];
      mgr.api.settings.display.layoutMode = window.alphaTab.LayoutMode.Horizontal;
      mgr.api.settings.display.staveProfile = getConfiguredStaveProfile();
      mgr.api.settings.display.scale = preset.scale || 0.72;
      mgr.renderedTimeline = null;
      mgr.api.updateSettings();
      mgr.api.render();
    } catch (_) {}
  }

  function populateTrackDropdown(score) {
    const sel = document.getElementById('score-track-select');
    if (!sel || !score || !Array.isArray(score.tracks)) return;
    if (score.tracks.length <= 1) {
      sel.style.display = 'none';
      return;
    }
    sel.style.display = 'inline-block';
    sel.innerHTML = '';
    score.tracks.forEach((tr, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = tr.name || `Pista ${idx + 1}`;
      sel.appendChild(opt);
    });
  }

  function applyPanelSize() {
    const panel = document.getElementById('score-split-panel');
    const sizeBtn = document.getElementById('btn-score-size');
    const staveBtn = document.getElementById('btn-score-stave');
    const preset = SCORE_HEIGHTS[mgr.sizeIdx] || SCORE_HEIGHTS[0];
    if (panel) panel.style.height = preset.css;
    if (sizeBtn) sizeBtn.textContent = preset.key;
    if (staveBtn) staveBtn.textContent = mgr.staveMode === 'tab' ? 'Pent+Tab' : '6 Cuerdas';
    if (mgr.isNativeSplitOpen && window.AndroidBridge && typeof window.AndroidBridge.setSongsterrSplitHeight === 'function') {
      window.AndroidBridge.setSongsterrSplitHeight(preset.nativePct);
    }
  }

  function openNativeSongsterr(info) {
    if (!info || !info.songsterrUrl) return false;
    const preset = SCORE_HEIGHTS[mgr.sizeIdx] || SCORE_HEIGHTS[0];
    if (window.AndroidBridge && typeof window.AndroidBridge.openSongsterrSplit === 'function') {
      mgr.isNativeSplitOpen = true;
      window.AndroidBridge.openSongsterrSplit(
        info.songsterrUrl,
        `${info.artist ? info.artist + ' - ' : ''}${info.title}`,
        preset.nativePct
      );
      updateToggleButtonForSong(mgr.currentSong);
      return true;
    }

    window.open(info.songsterrUrl, '_blank', 'noopener');
    return true;
  }

  async function openInAppAlphaTab(song, info) {
    const panel = document.getElementById('score-split-panel');
    const badge = document.getElementById('score-source-badge');
    const banner = document.getElementById('score-status-banner');
    const btnSt = document.getElementById('btn-score-songsterr');
    const btnChartToggle = document.getElementById('btn-score-chart-toggle');
    const sel = document.getElementById('score-track-select');
    if (!panel) return;

    mgr.isPanelOpen = true;
    saveOpenPref(true);
    panel.style.display = 'flex';
    applyPanelSize();
    if (sel) sel.style.display = 'none';
    if (banner) banner.style.display = 'none';
    if (btnSt) btnSt.style.display = info && info.songsterrUrl ? 'inline-flex' : 'none';
    if (btnChartToggle) {
      const canToggle = !info.hasCustom && !!info.tabTex && info.hasChart;
      btnChartToggle.style.display = canToggle ? 'inline-flex' : 'none';
      btnChartToggle.textContent = mgr.preferRiffMode ? 'Tema Completo' : 'Solo Riff';
    }

    const api = ensureAlphaTabApi();
    if (!api) {
      if (banner) {
        banner.style.display = 'flex';
        banner.textContent = 'Cargando motor de tablatura 6 cuerdas...';
      }
      return;
    }

    if (info.hasCustom) {
      const rec = await getCustomGpFile(info.customSongKey);
      if (rec && rec.bytes) {
        mgr.currentScoreMode = 'customGp';
        mgr.currentChartFullSync = true;
        const loadKey = `gp:${info.customSongKey}:${rec.savedAt}`;
        if (badge) badge.textContent = '🎸 Tab .gp (6 Cuerdas)';
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

    const useRiffOnly = !!info.tabTex && mgr.preferRiffMode;
    const tex = useRiffOnly
      ? info.tabTex
      : expandCompactChartToAlphaTex(info.chart, info.liveTabBars);

    if (tex) {
      mgr.currentScoreMode = 'alphaTex';
      mgr.currentChartFullSync = !useRiffOnly;
      const editSig = info.liveTabBars && info.liveTabBars.length ? info.liveTabBars.join('').length : 0;
      const loadKey = `tex:${song.id}:${useRiffOnly ? 'riff' : 'full'}:${editSig}`;
      if (badge) {
        badge.textContent = useRiffOnly
          ? '🎸 Riff Tab (6C)'
          : (info.songsterrId ? '🎸 Tab 6C · Songsterr' : '🎸 Tab 6 Cuerdas');
      }
      if (mgr.lastLoadedKey !== loadKey) {
        mgr.lastLoadedKey = loadKey;
        mgr.renderedTimeline = null;
        if (typeof api.tex === 'function') {
          api.tex(tex, [0]);
        } else {
          api.load(new TextEncoder().encode(tex), [0]);
        }
        const scroller = document.getElementById('score-scroll-container');
        if (scroller) scroller.scrollLeft = 0;
      }
      startSyncTicker();
      updateToggleButtonForSong(song);
    }
  }

  function closeInAppScorePanel(keepNativeState = false, preservePref = false) {
    mgr.isPanelOpen = false;
    mgr.currentScoreMode = null;
    if (!preservePref) saveOpenPref(false);
    stopSyncTicker();
    const panel = document.getElementById('score-split-panel');
    if (panel) panel.style.display = 'none';
    if (!keepNativeState && mgr.isNativeSplitOpen) {
      mgr.isNativeSplitOpen = false;
      if (window.AndroidBridge && typeof window.AndroidBridge.hideSongsterrSplit === 'function') {
        window.AndroidBridge.hideSongsterrSplit();
      }
    }
    if (mgr.currentSong) updateToggleButtonForSong(mgr.currentSong);
  }

  async function toggle() {
    const song = mgr.currentSong || (typeof state !== 'undefined' && state.currentSong);
    if (!song) return;

    if (mgr.isPanelOpen || mgr.isNativeSplitOpen) {
      closeInAppScorePanel(false);
      return;
    }

    const info = getSongScoreInfo(song);
    if (!info) return;
    await openInAppAlphaTab(song, info);
  }

  async function onSongChanged(song) {
    mgr.currentSong = song;
    mgr.offsetSec = 0;
    mgr.lastLoadedKey = '';
    mgr.userTouchHoldUntil = 0;
    updateToggleButtonForSong(song);

    if (song && !getStaticScoreMeta(song)) {
      discoverLiveSongsterrIfNeeded(song);
    }

    let wantOpen = mgr.isPanelOpen || mgr.isNativeSplitOpen;
    if (!wantOpen) {
      try { wantOpen = localStorage.getItem(PREF_OPEN_KEY) === '1'; } catch (_) {}
    }
    if (!wantOpen) return;

    const info = getSongScoreInfo(song);
    if (!info) {
      closeInAppScorePanel(false, true);
      return;
    }

    if (mgr.isNativeSplitOpen && !info.hasCustom && info.songsterrUrl) {
      openNativeSongsterr(info);
    } else {
      await openInAppAlphaTab(song, info);
    }
  }

  function refreshCurrentSongIfOpen() {
    if (!mgr.isPanelOpen || !mgr.currentSong) return;
    mgr.lastLoadedKey = '';
    const info = getSongScoreInfo(mgr.currentSong);
    if (info) openInAppAlphaTab(mgr.currentSong, info);
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

  function init() {
    loadLiveCache();
    refreshCustomGpKeys();

    window.onNativeScoreSplitClosed = () => {
      mgr.isNativeSplitOpen = false;
      if (mgr.currentSong) updateToggleButtonForSong(mgr.currentSong);
    };

    const btnToggle = document.getElementById('btn-toggle-score-panel');
    if (btnToggle) btnToggle.addEventListener('click', toggle);

    const btnToggleExp = document.getElementById('btn-toggle-score-panel-exp');
    if (btnToggleExp) btnToggleExp.addEventListener('click', toggle);

    const btnHide = document.getElementById('btn-score-hide');
    if (btnHide) btnHide.addEventListener('click', () => closeInAppScorePanel(false));

    const btnSize = document.getElementById('btn-score-size');
    if (btnSize) {
      btnSize.addEventListener('click', () => {
        mgr.sizeIdx = (mgr.sizeIdx + 1) % SCORE_HEIGHTS.length;
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

    const btnChartToggle = document.getElementById('btn-score-chart-toggle');
    if (btnChartToggle) {
      btnChartToggle.addEventListener('click', async () => {
        mgr.preferRiffMode = !mgr.preferRiffMode;
        mgr.lastLoadedKey = '';
        const s = mgr.currentSong || (typeof state !== 'undefined' && state.currentSong);
        const info = getSongScoreInfo(s);
        if (s && info) await openInAppAlphaTab(s, info);
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

    const btnSongsterr = document.getElementById('btn-score-songsterr');
    if (btnSongsterr) {
      btnSongsterr.addEventListener('click', () => {
        const info = getSongScoreInfo(mgr.currentSong);
        if (info && info.songsterrUrl) openNativeSongsterr(info);
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
          mgr.renderedTimeline = null;
          mgr.api.renderTracks([tr]);
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
          if (typeof showToast === 'function') showToast(`Partitura "${file.name}" vinculada y lista`, 'success', 2500);
          const s = mgr.currentSong || (typeof state !== 'undefined' && state.currentSong);
          if (s && s.id === songId) {
            const info = getSongScoreInfo(s);
            if (info) await openInAppAlphaTab(s, info);
          }
        } catch (err) {
          if (typeof showToast === 'function') showToast('Error cargando archivo de partitura: ' + (err.message || err), 'warn', 3000);
        }
      });
    }
  }

  mgr.init = init;
  mgr.toggle = toggle;
  mgr.hide = () => closeInAppScorePanel(false);
  mgr.onSongChanged = onSongChanged;
  mgr.refreshCurrentSongIfOpen = refreshCurrentSongIfOpen;
  mgr.getSongScoreInfo = getSongScoreInfo;
  mgr.promptGpImport = promptGpImport;
  mgr.expandCompactChartToAlphaTex = expandCompactChartToAlphaTex;

  window.ScoreSplitManager = mgr;
})();
