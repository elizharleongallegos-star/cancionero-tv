/**
 * @file karaokeTapCalibrator.js
 * @version 4.0.0 (Motor Unificado SSoT de Sincronización Karaoke + Voz-a-Letra)
 * @description Controlador Frontend de Karaoke con:
 *  - Renderizado único sin doble sobreescritura (Acordes + Tiempo + Letra palabra por palabra)
 *  - Signo de offset coherente en toda la app: effectiveTime = audioSec + globalOffsetSec
 *  - Calibración persistente por (songId + videoId)
 *  - Modo Tap (Hard Anchors) y Motor de Detección/Interpretación de Voz (VoiceKaraokeMatcher)
 */

function normalizePhoneticEs(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf\s]/g, ' ')
        .replace(/\bh([aeiou])/g, '$1')
        .replace(/v/g, 'b')
        .replace(/z/g, 's')
        .replace(/c([ei])/g, 's$1')
        .replace(/qu/g, 'k')
        .replace(/k/g, 'c')
        .replace(/ll/g, 'y')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenDice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 3 || b.length < 3) return a === b ? 1 : 0;
    if (a.includes(b) || b.includes(a)) {
        return Math.min(a.length, b.length) / Math.max(a.length, b.length);
    }
    const bg = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };
    const sa = bg(a), sb = bg(b);
    let hit = 0;
    sa.forEach(x => { if (sb.has(x)) hit++; });
    return (2 * hit) / (sa.size + sb.size);
}

function fmtMmSs(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

class VoiceKaraokeMatcher {
    constructor() {
        this.lastMatchedLineIdx = -1;
        this.lastTranscript = '';
        this.recentOffsets = [];
    }

    reset() {
        this.lastMatchedLineIdx = -1;
        this.lastTranscript = '';
        this.recentOffsets = [];
    }

    /**
     * Compara las palabras recientes interpretadas por reconocimiento de voz
     * contra todas las líneas cantables de la canción actual.
     */
    matchTranscript(transcript, lines, audioSec) {
        const clean = normalizePhoneticEs(transcript);
        if (!clean || clean === this.lastTranscript) return null;
        this.lastTranscript = clean;

        const heardAll = clean.split(' ').filter(w => w.length >= 2);
        if (heardAll.length === 0) return null;

        // Analizar ventana deslizante de las últimas palabras escuchadas
        const tailWords = heardAll.slice(-10);
        const cantableLines = lines.filter(l => l.cantable && l.phoneticText);
        if (cantableLines.length === 0) return null;

        let bestLine = null;
        let bestScore = 0;
        let bestHits = 0;

        for (let i = 0; i < cantableLines.length; i++) {
            const line = cantableLines[i];
            const lineTokens = normalizePhoneticEs(line.phoneticText).split(' ').filter(w => w.length >= 2);
            if (lineTokens.length === 0) continue;

            // Contar cuántos tokens del verso coinciden en secuencia / proximidad dentro de tailWords
            let hits = 0;
            let simSum = 0;
            let orderPtr = 0;
            for (const lt of lineTokens) {
                let bestT = 0;
                let bestPos = -1;
                for (let h = orderPtr; h < tailWords.length; h++) {
                    const sim = tokenDice(lt, tailWords[h]);
                    if (sim > bestT) {
                        bestT = sim;
                        bestPos = h;
                    }
                }
                if (bestT >= 0.72) {
                    hits++;
                    simSum += bestT;
                    if (bestPos !== -1) orderPtr = bestPos + 1;
                }
            }

            if (hits === 0) continue;
            const lineRecall = hits / lineTokens.length;
            const heardCoverage = hits / Math.min(tailWords.length, lineTokens.length);
            let score = (simSum / lineTokens.length) * 0.65 + heardCoverage * 0.35;

            // Ligero bono si avanza progresivamente después de la última línea detectada
            if (this.lastMatchedLineIdx >= 0) {
                if (line.index > this.lastMatchedLineIdx && line.index <= this.lastMatchedLineIdx + 8) {
                    score += 0.14;
                }
            }

            const minHitsRequired = lineTokens.length <= 2 ? 1 : 2;
            if (hits >= minHitsRequired && lineRecall >= 0.42 && score > bestScore) {
                bestScore = score;
                bestLine = line;
                bestHits = hits;
            }
        }

        if (!bestLine || bestScore < 0.54) return null;

        this.lastMatchedLineIdx = bestLine.index;
        // Compensación estimada por latencia media del reconocedor de voz parcial (~0.40s)
        const estimatedVoiceSec = Math.max(0, Number(audioSec || 0) - 0.40);
        let suggestedOffset = Number((bestLine.start - estimatedVoiceSec).toFixed(1));

        // Suavizado por consenso temporal si dos frases seguidas concuerdan dentro de +/- 1.8s
        this.recentOffsets.push(suggestedOffset);
        if (this.recentOffsets.length > 4) this.recentOffsets.shift();
        if (this.recentOffsets.length >= 2) {
            const prev = this.recentOffsets[this.recentOffsets.length - 2];
            if (Math.abs(prev - suggestedOffset) <= 1.8) {
                suggestedOffset = Number(((prev + suggestedOffset) / 2).toFixed(1));
            }
        }

        return {
            lineIndex: bestLine.index,
            lineText: bestLine.phoneticText,
            lineStart: bestLine.start,
            audioSec: estimatedVoiceSec,
            suggestedOffset,
            hits: bestHits,
            confidence: Number(Math.min(0.99, bestScore).toFixed(2))
        };
    }
}

class KaraokeSyncController {
    constructor(options = {}) {
        this.songId = 'default';
        this.videoId = 'default';
        this.storageKey = 'default::default';
        this.lines = [];
        this.hardAnchors = {};
        this.globalOffsetSec = 0.0; // effectiveTime = audioTime + globalOffsetSec
        this.isCalibrationMode = false;
        this.calibrationCursor = -1;
        this.lastActiveIndex = -1;
        this.lastActiveWordKey = '';
        this.hasTimedSource = false;

        this.getCurrentTime = options.getCurrentTime || (() => 0);
        this.seekToTime = options.seekToTime || null;
        this.onSaveAnchors = options.onSaveAnchors || (() => {});
        this.onOffsetChanged = options.onOffsetChanged || (() => {});
        this.containerEl = options.containerEl || null;
        this.voiceMatcher = new VoiceKaraokeMatcher();
    }

    normalizeAndRepairLines(rawLines) {
        const normalized = rawLines.map((item, idx) => {
            if (Array.isArray(item)) {
                let start = Number(item[0] !== undefined && item[0] !== null ? item[0] : 0);
                let end = Number(item[1] !== undefined && item[1] !== null ? item[1] : (start + 2.5));
                const typeCode = Number(item[2] !== undefined && item[2] !== null ? item[2] : 0); // 0 = Letra, 1 = Acordes, 2 = Sección/Meta
                const text = String(item[3] !== undefined && item[3] !== null ? item[3] : '').trim();
                const wordStarts = Array.isArray(item[4]) ? item[4].map(Number) : [];

                if (typeCode === 0 && wordStarts.length >= 2 && wordStarts[0] < 2.2 && (wordStarts[1] - wordStarts[0]) > 4.0) {
                    wordStarts[0] = Math.max(0, Number((wordStarts[1] - 0.45).toFixed(2)));
                }
                if (typeCode === 0 && wordStarts.length > 0 && Math.abs(start - wordStarts[0]) > 0.35) {
                    start = wordStarts[0];
                    end = Math.max(start + 0.8, wordStarts[wordStarts.length - 1] + 0.6);
                }

                const isChordOrMeta = typeCode !== 0 ||
                    /^[-=_*.\s…]+$/.test(text) ||
                    /^\(?k?oro:?\)?$/i.test(text) ||
                    /^(?:PM\s*=|Cejill?a|Capo|ESQUEMA|Intro|Solo|Estrofa|Estribillo|Cambio)/i.test(text);

                const wordsText = text.split(/\s+/).filter(Boolean);
                const words = wordsText.map((w, wIdx) => {
                    const wStart = wordStarts[wIdx] !== undefined
                        ? wordStarts[wIdx]
                        : start + (wIdx / Math.max(1, wordsText.length)) * Math.max(0.5, end - start);
                    const wEnd = wordStarts[wIdx + 1] !== undefined
                        ? Math.max(wStart + 0.12, wordStarts[wIdx + 1])
                        : Math.max(wStart + 0.25, end);
                    return { word: w, start: Number(wStart.toFixed(2)), end: Number(wEnd.toFixed(2)) };
                });

                return {
                    index: idx,
                    type: isChordOrMeta ? (typeCode === 1 ? 'CHORD' : 'META') : 'LYRIC',
                    cantable: !isChordOrMeta,
                    chord: '',
                    raw: text,
                    phoneticText: text,
                    start: Number(start.toFixed(2)),
                    end: Number(end.toFixed(2)),
                    words,
                    attachedChordsLine: null
                };
            }

            const start = typeof item.startSec === 'number' ? item.startSec : (typeof item.start === 'number' ? item.start : 0);
            const end = typeof item.endSec === 'number' ? item.endSec : (typeof item.end === 'number' ? item.end : start + 2.5);
            const isHdr = Boolean(item.isHeader);
            const text = String(item.text || item.phoneticText || item.raw || '').trim();
            const isCantable = !isHdr && (item.cantable !== undefined ? Boolean(item.cantable) : Boolean(item.isLyric !== false));

            let words = [];
            if (Array.isArray(item.words) && item.words.length > 0) {
                words = item.words;
            } else if (isCantable && text) {
                const ws = text.split(/\s+/).filter(Boolean);
                const wStarts = Array.isArray(item.wordStarts) ? item.wordStarts : [];
                words = ws.map((w, wi) => {
                    const wS = wStarts[wi] !== undefined ? Number(wStarts[wi]) : start + (wi / Math.max(1, ws.length)) * Math.max(0.5, end - start);
                    const wE = wStarts[wi + 1] !== undefined ? Math.max(wS + 0.12, Number(wStarts[wi + 1])) : Math.max(wS + 0.2, end);
                    return { word: w, start: Number(wS.toFixed(2)), end: Number(wE.toFixed(2)) };
                });
            }

            return {
                index: idx,
                type: isHdr ? 'META' : (isCantable ? 'LYRIC' : 'CHORD'),
                cantable: isCantable,
                chord: item.chord || '',
                raw: text,
                phoneticText: text,
                start: Number(start.toFixed(2)),
                end: Number(end.toFixed(2)),
                words,
                attachedChordsLine: item.chord || item.attachedChordsLine || null
            };
        });

        // Mantener acordes, encabezados y versos SEPARADOS en el orden exacto del documento PDF/Word
        // Vincular cada línea CHORD hacia su verso posterior únicamente para resaltado visual, sin mezclar textos.
        const pendingChords = [];
        let lastCantableIdx = -1;
        for (let i = 0; i < normalized.length; i++) {
            const cur = normalized[i];
            cur.attachedChordsLine = null;
            if (cur.type === 'CHORD') {
                cur.belongsToLyricIndex = null;
                pendingChords.push(cur);
            } else if (cur.cantable) {
                while (pendingChords.length > 0) {
                    const ch = pendingChords.shift();
                    ch.belongsToLyricIndex = cur.index;
                }
                if (lastCantableIdx !== -1) {
                    const prev = normalized[lastCantableIdx];
                    if (prev.end >= cur.start) {
                        prev.end = Math.max(prev.start + 0.35, Number((cur.start - 0.05).toFixed(2)));
                    } else if (prev.end - prev.start > 8.5) {
                        prev.end = Number((prev.start + 6.5).toFixed(2));
                    }
                }
                lastCantableIdx = i;
            }
        }

        return normalized;
    }

    loadSongData(songData, songId = 'default', videoId = 'default', hasTimedSource = true) {
        this.songId = String(songId || 'default');
        this.videoId = String(videoId || 'default');
        this.storageKey = `${this.songId}::${this.videoId}`;
        this.hasTimedSource = Boolean(hasTimedSource);

        const rawList = (songData && (Array.isArray(songData.l) ? songData.l : songData.lines)) || (Array.isArray(songData) ? songData : []);
        this.lines = this.normalizeAndRepairLines(rawList);
        this.lastActiveIndex = -1;
        this.lastActiveWordKey = '';
        this.voiceMatcher.reset();

        try {
            const savedOffsetKey = localStorage.getItem(`karaoke_offset_${this.storageKey}`);
            const savedOffset = savedOffsetKey !== null ? savedOffsetKey : localStorage.getItem(`karaoke_offset_${this.songId}`);
            this.globalOffsetSec = savedOffset !== null && !isNaN(parseFloat(savedOffset)) ? parseFloat(savedOffset) : 0.0;

            const savedAnchors = localStorage.getItem(`karaoke_anchors_${this.storageKey}`) ||
                                 localStorage.getItem(`karaoke_anchors_${this.songId}`);
            this.hardAnchors = savedAnchors ? JSON.parse(savedAnchors) : {};
            this.applyHardAnchors();
        } catch (_) {
            this.globalOffsetSec = 0.0;
            this.hardAnchors = {};
        }

        this.calibrationCursor = this.lines.findIndex(l => l.cantable);
        this.renderDOM();
        this.onOffsetChanged(this.globalOffsetSec);
    }

    loadSanitizedSong(syncedData, songId = 'default', videoId = 'default') {
        return this.loadSongData(syncedData, songId, videoId, true);
    }

    applyHardAnchors() {
        for (const line of this.lines) {
            if (!line.cantable) continue;
            const anchor = this.hardAnchors[line.index];
            if (anchor && typeof anchor.start === 'number') {
                line.start = anchor.start;
                line.end = typeof anchor.end === 'number' ? anchor.end : Number((anchor.start + 3.2).toFixed(2));
                if (Array.isArray(line.words) && line.words.length > 0) {
                    const span = Math.max(0.5, line.end - line.start);
                    line.words = line.words.map((w, wi) => {
                        const s = line.start + (wi / Math.max(1, line.words.length)) * span;
                        const e = line.start + ((wi + 1) / Math.max(1, line.words.length)) * span;
                        return { ...w, start: Number(s.toFixed(2)), end: Number(e.toFixed(2)) };
                    });
                }
            }
        }
    }

    setOffset(nextOffsetSec) {
        this.globalOffsetSec = Number((Number(nextOffsetSec) || 0).toFixed(1));
        try {
            localStorage.setItem(`karaoke_offset_${this.storageKey}`, String(this.globalOffsetSec));
        } catch (_) {}
        this.onOffsetChanged(this.globalOffsetSec);
        return this.globalOffsetSec;
    }

    adjustOffset(deltaSec) {
        return this.setOffset(this.globalOffsetSec + deltaSec);
    }

    toggleCalibrationMode(forceState) {
        this.isCalibrationMode = typeof forceState === 'boolean' ? forceState : !this.isCalibrationMode;
        if (this.isCalibrationMode) {
            this.calibrationCursor = this.lines.findIndex(l => l.cantable);
        }
        this.renderDOM();
        return this.isCalibrationMode;
    }

    registerTapAnchor(targetIdx = null) {
        const idx = typeof targetIdx === 'number' ? targetIdx : this.calibrationCursor;
        if (idx === -1 || !this.lines[idx] || !this.lines[idx].cantable) return null;

        const now = Math.max(0, Number((this.getCurrentTime()).toFixed(2)));
        const currentLine = this.lines[idx];

        // Cerrar verso previo justo antes de este toque
        for (let prev = idx - 1; prev >= 0; prev--) {
            if (this.lines[prev].cantable) {
                const prevIdx = this.lines[prev].index;
                if (this.hardAnchors[prevIdx]) {
                    this.hardAnchors[prevIdx].end = Math.max(this.hardAnchors[prevIdx].start + 0.35, Number((now - 0.05).toFixed(2)));
                    this.lines[prev].end = this.hardAnchors[prevIdx].end;
                }
                break;
            }
        }

        const defaultEnd = Number((now + 3.2).toFixed(2));
        this.hardAnchors[currentLine.index] = { start: now, end: defaultEnd };
        currentLine.start = now;
        currentLine.end = defaultEnd;

        // Si había líneas sin ancla posterior, re-estimarlas suavemente a partir de ahora
        let stepAcc = defaultEnd + 0.15;
        for (let f = idx + 1; f < this.lines.length; f++) {
            if (!this.lines[f].cantable) continue;
            if (this.hardAnchors[this.lines[f].index]) break;
            if (!this.hasTimedSource) {
                this.lines[f].start = Number(stepAcc.toFixed(2));
                this.lines[f].end = Number((stepAcc + 3.0).toFixed(2));
                stepAcc += 3.15;
            }
        }

        let nextIdx = -1;
        for (let i = idx + 1; i < this.lines.length; i++) {
            if (this.lines[i].cantable) {
                nextIdx = i;
                break;
            }
        }
        this.calibrationCursor = nextIdx;

        try {
            localStorage.setItem(`karaoke_anchors_${this.storageKey}`, JSON.stringify(this.hardAnchors));
        } catch (_) {}
        this.onSaveAnchors(this.hardAnchors);
        this.renderDOM();

        return { lineIndex: currentLine.index, start: now };
    }

    /**
     * Interpreta frase reconocida por voz y calza automáticamente la canción actual.
     */
    processVoiceTranscript(transcript, rawAudioSec) {
        const match = this.voiceMatcher.matchTranscript(transcript, this.lines, rawAudioSec);
        if (!match) return null;

        if (!this.hasTimedSource) {
            // Canción sin tiempos previos: anclar directamente el verso en el tiempo real de audio y extrapolar
            this.registerTapAnchor(match.lineIndex);
        } else {
            // Canción con base temporal: ajustar automáticamente el offset al tiempo vocal real detectado
            this.setOffset(match.suggestedOffset);
        }

        this.updateActiveLine(rawAudioSec, true);
        return match;
    }

    updateActiveLine(rawCurrentTimeSec, forceScroll = false) {
        if (!this.containerEl || this.lines.length === 0) return;

        // Única fórmula maestra coherente en toda la aplicación
        const effectiveTime = Math.max(0, (Number(rawCurrentTimeSec) || 0) + (Number(this.globalOffsetSec) || 0));
        let activeIdx = -1;

        // Anticipación de medio segundo (-0.50s) para una lectura y canto fluidos
        const WORD_LEAD_SEC = 0.50;
        const LINE_LEAD_SEC = 0.50;

        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            if (!line.cantable) continue;
            if (effectiveTime >= line.start - LINE_LEAD_SEC && effectiveTime <= line.end + 0.15) {
                activeIdx = line.index;
                break;
            }
        }

        // Mantener brevemente resaltado entre pausas cortas (<1.8s)
        if (activeIdx === -1) {
            for (let i = this.lines.length - 1; i >= 0; i--) {
                const line = this.lines[i];
                if (!line.cantable) continue;
                if (effectiveTime >= line.start - LINE_LEAD_SEC && effectiveTime <= line.end + 1.8) {
                    activeIdx = line.index;
                    break;
                }
                if (effectiveTime >= line.start) break;
            }
        }

        const chordRows = this.containerEl.querySelectorAll('.karaoke-chord-row[data-next-lyric]');
        chordRows.forEach(cEl => {
            const nextIdx = parseInt(cEl.dataset.nextLyric, 10);
            cEl.classList.toggle('karaoke-chord-active', activeIdx !== -1 && nextIdx === activeIdx);
        });

        const nodes = this.containerEl.querySelectorAll('.karaoke-node[data-line-index]');
        nodes.forEach(el => {
            const idx = parseInt(el.dataset.lineIndex, 10);
            const lineObj = this.lines[idx];
            const isPast = activeIdx !== -1 && idx < activeIdx;
            const isCurrent = idx === activeIdx;

            el.classList.toggle('karaoke-active-line', isCurrent);
            el.classList.toggle('active', isCurrent);
            el.classList.toggle('past', isPast);

            const wordSpans = el.querySelectorAll('.karaoke-word');
            if (isCurrent && lineObj && Array.isArray(lineObj.words)) {
                let activeW = -1;
                for (let wIdx = 0; wIdx < lineObj.words.length; wIdx++) {
                    const w = lineObj.words[wIdx];
                    if (w && effectiveTime >= Math.max(0, w.start - WORD_LEAD_SEC)) {
                        activeW = wIdx;
                    }
                }
                wordSpans.forEach((span, wIdx) => {
                    const isWAct = wIdx === activeW;
                    const isWPast = activeW > -1 && wIdx < activeW;
                    span.classList.toggle('karaoke-word-active', isWAct);
                    span.classList.toggle('active-word', isWAct);
                    span.classList.toggle('past-word', isWPast);
                });

                if (this.lastActiveIndex !== activeIdx || forceScroll) {
                    this.lastActiveIndex = activeIdx;
                    try {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    } catch (_) {}
                }
            } else {
                wordSpans.forEach(span => {
                    span.classList.remove('karaoke-word-active', 'active-word');
                    span.classList.toggle('past-word', isPast);
                });
            }
        });
    }

    renderDOM() {
        if (!this.containerEl) return;
        this.containerEl.innerHTML = '';

        this.lines.forEach((line) => {
            if (line.type === 'META') {
                const tag = document.createElement('div');
                tag.className = 'karaoke-node karaoke-section-tag karaoke-type-meta';
                tag.dataset.lineIndex = line.index;
                tag.textContent = line.raw;
                this.containerEl.appendChild(tag);
                return;
            }

            if (line.type === 'CHORD') {
                const chordRow = document.createElement('div');
                chordRow.className = 'karaoke-chord-row';
                chordRow.dataset.lineIndex = line.index;
                if (line.belongsToLyricIndex !== null && line.belongsToLyricIndex !== undefined) {
                    chordRow.dataset.nextLyric = String(line.belongsToLyricIndex);
                }
                chordRow.textContent = line.raw;
                if (typeof this.seekToTime === 'function' && typeof line.start === 'number' && line.start > 0) {
                    chordRow.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const targetAudioSec = Math.max(0, line.start - (this.globalOffsetSec || 0));
                        this.seekToTime(targetAudioSec);
                    });
                }
                this.containerEl.appendChild(chordRow);
                return;
            }

            if (line.type === 'LYRIC') {
                const row = document.createElement('div');
                row.className = 'karaoke-node karaoke-line-item karaoke-type-lyric';
                row.dataset.lineIndex = line.index;

                const lyricWrap = document.createElement('div');
                lyricWrap.className = 'karaoke-lyric-row-wrap';

                const lyricText = document.createElement('div');
                lyricText.className = 'karaoke-line-lyrics karaoke-lyric-text';

                if (Array.isArray(line.words) && line.words.length > 0) {
                    line.words.forEach((wItem, wIdx) => {
                        const span = document.createElement('span');
                        span.className = 'karaoke-word';
                        span.textContent = wItem.word + (wIdx < line.words.length - 1 ? ' ' : '');
                        lyricText.appendChild(span);
                    });
                } else {
                    lyricText.textContent = line.phoneticText;
                }

                lyricWrap.appendChild(lyricText);

                const timeEl = document.createElement('span');
                timeEl.className = 'karaoke-line-time';
                timeEl.textContent = fmtMmSs(line.start);
                lyricWrap.appendChild(timeEl);

                row.appendChild(lyricWrap);

                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (typeof this.seekToTime === 'function' && typeof line.start === 'number') {
                        const targetAudioSec = Math.max(0, line.start - (this.globalOffsetSec || 0));
                        this.seekToTime(targetAudioSec);
                    }
                });

                this.containerEl.appendChild(row);
            }
        });
    }
}

if (typeof window !== 'undefined') {
    window.KaraokeSyncController = KaraokeSyncController;
    window.VoiceKaraokeMatcher = VoiceKaraokeMatcher;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KaraokeSyncController, VoiceKaraokeMatcher };
}
