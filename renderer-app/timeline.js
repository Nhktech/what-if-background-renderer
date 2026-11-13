/* What If Studio — visual video + audio review & editing timeline.
 *
 * Shows the real project video and the real sound-plan events as separate
 * audio tracks. Waveforms are decoded from the actual asset files (Web Audio
 * API) — no decorative fake data.
 *
 * Audio engine notes (Android WebView hardened):
 * - Waveforms are decoded with an OfflineAudioContext at load time (works
 *   without a user gesture).
 * - Playback buffers are decoded with the live AudioContext inside the Play
 *   gesture, with a callback-form decodeAudioData fallback, and playback is
 *   (re)scheduled once decoding finishes — pressing Play before assets are
 *   decoded can no longer produce silence.
 *
 * Editing: clips can be dragged along the timeline, deleted, and their
 * start/duration/volume/pan edited directly. Changes accumulate as pending
 * edits and are applied to the real sound plan through /api/sound/plan-events,
 * which then rebuilds the preview.
 */
const TRACKS = ['sfx', 'ambience', 'music', 'narration'];
const TRACK_LABELS = {
  sfx: 'Sound Effects',
  ambience: 'Ambience',
  music: 'Music',
  narration: 'Narration'
};

const clipColors = {
  sfx: '#4ea3ff',
  ambience: '#7bd88f',
  music: '#c792ea',
  narration: '#ffcb6b'
};

const state = {
  projectPath: null,
  data: null,
  duration: 0,
  audioData: new Map(),    // assetUrl -> { raw, peaks, live }
  trackSettings: {},       // track -> { muted, solo, volume }
  audioCtx: null,
  masterGain: null,
  trackGains: {},
  activeSources: [],
  playing: false,
  selectedClip: null,
  pendingEvents: null,     // null = clean; array = edited copies of plan events
  dirty: false,
  rafId: null
};

const $ = id => document.getElementById(id);

function eventById(id) {
  const list = state.pendingEvents || state.data?.plan?.events || [];
  return list.find(event => event.id === id) || null;
}

function allEvents() {
  return state.pendingEvents || state.data?.plan?.events || [];
}

/* ---------- audio context & decoding ---------- */

function ensureAudioContext() {
  if (state.audioCtx) return state.audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  state.audioCtx = new Ctx();
  state.masterGain = state.audioCtx.createGain();
  state.masterGain.connect(state.audioCtx.destination);
  for (const track of TRACKS) {
    const gain = state.audioCtx.createGain();
    gain.connect(state.masterGain);
    state.trackGains[track] = gain;
  }
  applyTrackSettings();
  return state.audioCtx;
}

function decodeCompat(ctx, arrayBuffer) {
  // Some Android WebView versions only support the callback form of
  // decodeAudioData; prefer the promise form, fall back to callbacks.
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const promise = ctx.decodeAudioData(arrayBuffer.slice(0), buffer => {
        if (!settled) { settled = true; resolve(buffer); }
      }, error => {
        if (!settled) { settled = true; reject(error || new Error('decode failed')); }
      });
      if (promise && typeof promise.then === 'function') {
        promise.then(buffer => {
          if (!settled) { settled = true; resolve(buffer); }
        }, error => {
          if (!settled) { settled = true; reject(error || new Error('decode failed')); }
        });
      }
    } catch (error) {
      if (!settled) { settled = true; reject(error); }
    }
  });
}

async function fetchRaw(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.arrayBuffer();
}

async function loadAudioEntry(url) {
  if (state.audioData.has(url)) return state.audioData.get(url);
  const entry = { raw: null, peaks: null, live: null };
  state.audioData.set(url, entry);
  try {
    entry.raw = await fetchRaw(url);
    // Waveform peaks via OfflineAudioContext — no user gesture required.
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const offline = new OAC(1, 128, 44100);
      const buffer = await decodeCompat(offline, entry.raw);
      entry.peaks = computePeaks(buffer, 160);
      drawWaveformsFor(url);
    } catch {
      entry.peaks = null;
    }
    return entry;
  } catch {
    state.audioData.delete(url);
    return null;
  }
}

function computePeaks(buffer, buckets) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const step = Math.max(1, Math.floor(left.length / buckets));
  const peaks = [];
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * step;
    const end = Math.min(left.length, start + step);
    for (let j = start; j < end; j += 4) {
      const value = Math.abs(left[j]) + Math.abs(right[j]);
      if (value > peak) peak = value;
    }
    peaks.push(Math.min(1, peak / 2));
  }
  return peaks;
}

function drawWave(canvas, peaks, color) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width = canvas.offsetWidth * 2;
  const height = canvas.height = canvas.offsetHeight * 2;
  ctx.clearRect(0, 0, width, height);
  if (!peaks) return;
  ctx.fillStyle = color;
  const bar = Math.max(2, Math.floor(width / peaks.length) - 1);
  const middle = height / 2;
  peaks.forEach((peak, index) => {
    const x = (index / peaks.length) * width;
    const amplitude = Math.max(2, peak * height * 0.46);
    ctx.fillRect(x, middle - amplitude, bar, amplitude * 2);
  });
}

function drawWaveformsFor(url) {
  const entry = state.audioData.get(url);
  if (!entry || !entry.peaks) return;
  document.querySelectorAll(`canvas[data-asset="${cssEscape(url)}"]`).forEach(canvas => {
    drawWave(canvas, entry.peaks, canvas.dataset.color || clipColors.sfx);
  });
}

function cssEscape(value) {
  return (window.CSS && CSS.escape) ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/* ---------- track controls ---------- */

function trackAudible(track) {
  const settings = state.trackSettings[track];
  const anySolo = TRACKS.some(t => state.trackSettings[t].solo);
  if (settings.muted) return false;
  if (anySolo && !settings.solo) return false;
  return true;
}

function applyTrackSettings() {
  if (!state.audioCtx) return;
  for (const track of TRACKS) {
    const settings = state.trackSettings[track];
    const gain = state.trackGains[track];
    gain.gain.value = trackAudible(track) ? settings.volume : 0;
  }
}

/* ---------- rendering ---------- */

function percent(value) {
  return (value / Math.max(state.duration, 0.001) * 100).toFixed(3) + '%';
}

function renderRuler() {
  const ruler = $('timelineRuler');
  ruler.innerHTML = '';
  const total = state.duration;
  const step = total > 30 ? 5 : total > 10 ? 2 : total > 5 ? 1 : 0.5;
  for (let t = 0; t <= total + 0.001; t += step) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = percent(t);
    tick.innerHTML = `<span>${t.toFixed(step < 1 ? 1 : 0)}s</span>`;
    ruler.appendChild(tick);
  }
}

function buildTrackHeader(track) {
  const settings = state.trackSettings[track];
  const header = document.createElement('div');
  header.className = 'track-header';
  header.innerHTML = `
    <div class="track-name">${TRACK_LABELS[track]}</div>
    <div class="track-controls">
      <button type="button" class="track-btn mute ${settings.muted ? 'active' : ''}" data-track="${track}" title="Mute">M</button>
      <button type="button" class="track-btn solo ${settings.solo ? 'active' : ''}" data-track="${track}" title="Solo">S</button>
      <input type="range" class="track-volume" data-track="${track}" min="0" max="150" value="${Math.round(settings.volume * 100)}">
    </div>`;
  return header;
}

function render() {
  const data = state.data;
  const head = $('timelineHead');
  const lanes = $('timelineLanes');
  head.innerHTML = '';
  lanes.innerHTML = '';

  const videoHeader = document.createElement('div');
  videoHeader.className = 'track-header video';
  videoHeader.innerHTML = `<div class="track-name">Video</div><div class="track-note">source clip</div>`;
  head.appendChild(videoHeader);

  const videoLane = document.createElement('div');
  videoLane.className = 'timeline-lane video-lane';
  const videoClip = document.createElement('div');
  videoClip.className = 'clip video-clip';
  videoClip.style.left = '0%';
  videoClip.style.width = '100%';
  videoClip.innerHTML = `<span class="clip-label">${escapeHtml(data.manifest.title || 'Video')}</span>`;
  videoLane.appendChild(videoClip);
  lanes.appendChild(videoLane);

  for (const track of TRACKS) {
    head.appendChild(buildTrackHeader(track));

    const lane = document.createElement('div');
    lane.className = 'timeline-lane';
    lane.dataset.track = track;

    const events = allEvents().filter(event => event.track === track);
    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'lane-empty';
      empty.textContent = 'No clips — drag or ask GLM to add sounds';
      lane.appendChild(empty);
    }

    for (const event of events) {
      const clip = document.createElement('div');
      clip.className = 'clip audio-clip' + (state.selectedClip === event.id ? ' selected' : '');
      clip.style.left = percent(event.start);
      clip.style.width = percent(Math.max(event.duration, 0.05));
      clip.style.setProperty('--clip-color', clipColors[track]);
      clip.dataset.eventId = event.id;
      clip.dataset.start = String(event.start);

      if (event.assetUrl) {
        const canvas = document.createElement('canvas');
        canvas.className = 'clip-wave';
        canvas.dataset.asset = event.assetUrl;
        canvas.dataset.color = clipColors[track];
        clip.appendChild(canvas);
        const existing = state.audioData.get(event.assetUrl);
        if (existing && existing.peaks) {
          drawWave(canvas, existing.peaks, clipColors[track]);
        } else {
          loadAudioEntry(event.assetUrl);
        }
      } else {
        const missing = document.createElement('span');
        missing.className = 'clip-missing';
        missing.textContent = event.reuse ? `missing: ${event.reuse}` : 'no asset';
        clip.appendChild(missing);
      }

      const label = document.createElement('span');
      label.className = 'clip-label';
      label.textContent = event.id;
      clip.appendChild(label);

      attachClipGestures(clip, event);
      lane.appendChild(clip);
    }

    lanes.appendChild(lane);
  }

  renderRuler();
  updateActionsBar(state.dirty);
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

/* ---------- clip selection & editing ---------- */

function markDirty() {
  const original = state.data?.plan?.events || [];
  const pending = state.pendingEvents || [];
  const changed = pending.length !== original.length ||
    pending.some((event, index) => {
      const source = original.find(candidate => candidate.id === event.id);
      return !source ||
        Math.abs(source.start - event.start) > 1e-6 ||
        Math.abs(source.duration - event.duration) > 1e-6 ||
        Math.abs(source.volume - event.volume) > 1e-6 ||
        Math.abs((source.pan || 0) - (event.pan || 0)) > 1e-6;
    });
  state.pendingEvents = pending;
  state.dirty = changed;
  updateActionsBar(changed);
}

function updateActionsBar(dirty) {
  const bar = $('timelineActions');
  if (!bar) return;
  bar.hidden = !dirty;
}

function selectClip(event) {
  state.selectedClip = event.id;
  document.querySelectorAll('.audio-clip').forEach(clip => {
    clip.classList.toggle('selected', clip.dataset.eventId === event.id);
  });
  renderClipInfo(event);
}

function renderClipInfo(event) {
  const info = $('clipInfo');
  info.hidden = false;
  const assetState = event.assetUrl ? 'loaded ✓' :
    (event.reuse ? `missing: ${event.reuse}` : 'not generated yet');

  info.innerHTML = `
    <div class="clip-info-title">
      <strong>✥ ${escapeHtml(event.id)}</strong>
      <button type="button" class="clip-delete" id="clipDelete">🗑 Delete clip</button>
    </div>
    <div class="clip-edit-grid">
      <label>Start (s)<input type="number" id="editStart" min="0" max="${state.duration.toFixed(2)}" step="0.01" value="${event.start}"></label>
      <label>Duration (s)<input type="number" id="editDuration" min="0.05" step="0.01" value="${event.duration}"></label>
      <label>Volume<input type="number" id="editVolume" min="0" max="1.5" step="0.05" value="${event.volume}"></label>
      <label>Pan (−1 left … +1 right)<input type="number" id="editPan" min="-1" max="1" step="0.05" value="${event.pan}"></label>
    </div>
    <div class="clip-info-row"><span>Track</span><span>${escapeHtml(TRACK_LABELS[event.track] || event.track)}</span></div>
    <div class="clip-info-row"><span>Asset</span><span>${escapeHtml(assetState)}</span></div>
    ${event.description ? `<div class="clip-info-row"><span>Description</span><span>${escapeHtml(event.description)}</span></div>` : ''}
    ${event.prompt ? `<div class="clip-info-row"><span>Generation prompt</span><span>${escapeHtml(event.prompt)}</span></div>` : ''}
    <p class="note">Drag the clip to move it, or edit the numbers above. Press “Apply Changes” below the timeline to save and rebuild the preview. You can also just ask GLM.</p>`;

  $('clipDelete').addEventListener('click', () => deleteClip(event.id));
  for (const [field, id] of [['start', 'editStart'], ['duration', 'editDuration'],
                             ['volume', 'editVolume'], ['pan', 'editPan']]) {
    $(id).addEventListener('change', ev => {
      const value = parseFloat(ev.target.value);
      if (!Number.isFinite(value)) return;
      applyClipEdit(event.id, field, value);
    });
  }
}

function applyClipEdit(id, field, value) {
  const events = (state.pendingEvents || allEvents()).map(event =>
    event.id === id ? { ...event, [field]: value } : event);
  const target = events.find(event => event.id === id);
  if (!target) return;
  if (field === 'start') target.start = Math.max(0, Math.min(state.duration - 0.05, target.start));
  if (field === 'duration') target.duration = Math.max(0.05, Math.min(state.duration - target.start, target.duration));
  if (field === 'volume') target.volume = Math.max(0, target.volume);
  if (field === 'pan') target.pan = Math.max(-1, Math.min(1, target.pan));
  state.pendingEvents = events;
  markDirty();
  const fresh = eventById(id);
  if (fresh) { selectClip(fresh); }
  render();
}

function deleteClip(id) {
  const remaining = (state.pendingEvents || allEvents()).filter(event => event.id !== id);
  state.pendingEvents = remaining;
  state.selectedClip = null;
  $('clipInfo').hidden = true;
  markDirty();
  render();
}

/* ---------- drag to move clips ---------- */

function attachClipGestures(clip, event) {
  clip.addEventListener('pointerdown', downEvent => {
    if (downEvent.button !== undefined && downEvent.button !== 0) return;
    downEvent.preventDefault();
    clip.setPointerCapture(downEvent.pointerId);
    const startX = downEvent.clientX;
    const originalStart = event.start;
    let dragged = false;

    const onMove = moveEvent => {
      const deltaX = moveEvent.clientX - startX;
      if (!dragged && Math.abs(deltaX) < 6) return;
      if (!dragged && Math.abs(deltaX) >= 6) {
        dragged = true;
        clip.style.overflow = 'visible'; // let the time badge escape the clip
        clip.style.zIndex = '8';
      }
      const body = $('timelineRuler').getBoundingClientRect();
      const secondsPerPx = state.duration / body.width;
      const newStart = Math.max(0, Math.min(state.duration - Math.max(event.duration, 0.05),
        originalStart + deltaX * secondsPerPx));
      clip.style.left = percent(newStart);
      clip.dataset.start = String(newStart);
      let badge = clip.querySelector('.drag-badge') ||
        (clip.appendChild(Object.assign(document.createElement('span'), { className: 'drag-badge' })), clip.querySelector('.drag-badge'));
      badge.textContent = newStart.toFixed(2) + 's';
    };

    const onUp = upEvent => {
      clip.releasePointerCapture(downEvent.pointerId);
      clip.removeEventListener('pointermove', onMove);
      clip.removeEventListener('pointerup', onUp);
      clip.removeEventListener('pointercancel', onUp);
      const badge = clip.querySelector('.drag-badge');
      if (badge) badge.remove();
      clip.style.overflow = '';
      clip.style.zIndex = '';

      if (dragged) {
        const body = $('timelineRuler').getBoundingClientRect();
        const secondsPerPx = state.duration / body.width;
        const newStart = Math.max(0, Math.min(state.duration - Math.max(event.duration, 0.05),
          originalStart + (upEvent.clientX - startX) * secondsPerPx));
        applyClipEdit(event.id, 'start', Math.round(newStart * 100) / 100);
      } else {
        selectClip(event);
      }
    };

    clip.addEventListener('pointermove', onMove);
    clip.addEventListener('pointerup', onUp);
    clip.addEventListener('pointercancel', onUp);
  });
}

/* ---------- playback engine ---------- */

function stopAllSources() {
  for (const source of state.activeSources) {
    try { source.node.stop(); } catch { /* already stopped */ }
    try { source.node.disconnect(); } catch { /* already disconnected */ }
  }
  state.activeSources = [];
}

async function ensureLiveBuffers() {
  const statusEl = $('audioStatus');
  const urls = [...new Set(allEvents().filter(event => event.assetUrl).map(event => event.assetUrl))];
  if (!urls.length) {
    statusEl.hidden = false;
    statusEl.textContent = 'No audio assets yet — generate sounds first.';
    statusEl.className = 'audio-status warn';
    return false;
  }
  statusEl.hidden = false;
  statusEl.textContent = 'Preparing audio…';
  statusEl.className = 'audio-status';
  const missing = urls.filter(url => !state.audioData.get(url)?.live);
  for (const url of missing) {
    try {
      let entry = state.audioData.get(url);
      if (!entry) entry = await loadAudioEntry(url);
      if (!entry) throw new Error('download failed');
      if (!entry.live) {
        entry.live = await decodeCompat(state.audioCtx, entry.raw);
      }
    } catch {
      statusEl.hidden = false;
      statusEl.textContent = 'Could not decode an audio file — check the assets.';
      statusEl.className = 'audio-status warn';
      return false;
    }
  }
  statusEl.hidden = true;
  statusEl.textContent = '';
  return true;
}

function scheduleAudio(fromTime) {
  stopAllSources();
  const ctx = state.audioCtx;
  if (!ctx) return;

  const events = allEvents();
  const now = ctx.currentTime + 0.05;

  for (const event of events) {
    if (!event.assetUrl) continue;
    const entry = state.audioData.get(event.assetUrl);
    const buffer = entry && entry.live;
    if (!buffer) continue;

    const start = event.start;
    const end = start + Math.min(event.duration, buffer.duration);
    if (end <= fromTime) continue;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const clipGain = ctx.createGain();
    clipGain.gain.value = Math.max(0, event.volume);

    const offset = Math.max(0, fromTime - start);
    const when = now + Math.max(0, start - fromTime);

    let tail = clipGain;
    source.connect(clipGain);

    const pan = Math.max(-1, Math.min(1, event.pan || 0));
    if (pan !== 0 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      clipGain.connect(panner);
      tail = panner;
    }
    tail.connect(state.trackGains[event.track]);

    source.start(when, offset, Math.max(0, end - fromTime - offset));
    state.activeSources.push({ node: source, event });
  }
}

async function setPlaying(playing) {
  const video = $('reviewVideo');
  state.playing = playing;
  if (playing) {
    if ($('reviewUsePreview').checked) {
      video.play();
    } else {
      ensureAudioContext();
      if (state.audioCtx.state === 'suspended') {
        try { await state.audioCtx.resume(); } catch { /* ignored */ }
      }
      const ready = await ensureLiveBuffers();
      if (!ready) {
        state.playing = false;
        $('reviewPlay').textContent = '▶ Play';
        return;
      }
      scheduleAudio(video.currentTime);
      video.play();
    }
  } else {
    video.pause();
    stopAllSources();
  }
  $('reviewPlay').textContent = playing ? '❚❚ Pause' : '▶ Play';
}

function updatePlayhead() {
  const video = $('reviewVideo');
  const time = video.currentTime;
  $('timelinePlayhead').style.left = percent(time);
  $('reviewTime').textContent =
    time.toFixed(1) + ' / ' + state.duration.toFixed(1) + ' s';
  const scrub = $('reviewScrub');
  if (!scrubbing) {
    scrub.value = state.duration ? Math.round(time / state.duration * 1000) : 0;
  }
  state.rafId = requestAnimationFrame(updatePlayhead);
}

let scrubbing = false;

function startRaf() {
  if (!state.rafId) state.rafId = requestAnimationFrame(updatePlayhead);
}

/* ---------- pending changes ---------- */

async function applyChanges() {
  if (!state.pendingEvents || !state.projectPath) return;
  if (window.WhatIfTimeline.onApplyChanges) {
    await window.WhatIfTimeline.onApplyChanges(state.pendingEvents);
  }
}

function discardChanges() {
  state.pendingEvents = null;
  state.selectedClip = null;
  state.dirty = false;
  updateActionsBar(false);
  render();
  const info = $('clipInfo');
  info.hidden = true;
}

/* ---------- public API ---------- */

async function load(projectPath, data) {
  state.projectPath = projectPath;
  state.data = data;
  state.duration = Number(data.manifest.duration_seconds) || 0;
  state.selectedClip = null;
  state.pendingEvents = null;
  state.dirty = false;

  // Stop any playback from a previous state/project and clear the audio
  // cache — assets may have been regenerated between renders.
  setPlaying(false);
  state.audioData.clear();

  state.trackSettings = {};
  for (const track of TRACKS) {
    state.trackSettings[track] = { muted: false, solo: false, volume: 1 };
  }
  if (state.audioCtx) applyTrackSettings();

  $('reviewWorkspace').hidden = false;
  $('reviewTitle').textContent = 'Review: ' + (data.manifest.title || 'project');
  $('clipInfo').hidden = true;

  const video = $('reviewVideo');
  const usePreview = $('reviewUsePreview');
  usePreview.checked = false;
  usePreview.disabled = !data.outputs.previewExists;
  video.src = data.media.source;
  video.muted = !$('reviewSourceAudio').checked;

  render();
  startRaf();
}

function refresh(newState) {
  if (!state.projectPath) return;
  load(state.projectPath, newState);
}

function togglePreview(mixed) {
  const video = $('reviewVideo');
  const wasPlaying = state.playing;
  if (wasPlaying) setPlaying(false);
  video.src = mixed && state.data.outputs.previewExists
    ? state.data.media.preview
    : state.data.media.source;
  video.muted = mixed ? false : !$('reviewSourceAudio').checked;
  video.load();
  if (wasPlaying) setPlaying(true);
}

/* ---------- events ---------- */

document.addEventListener('click', event => {
  const mute = event.target.closest('.track-btn.mute');
  const solo = event.target.closest('.track-btn.solo');
  if (mute) {
    const track = mute.dataset.track;
    state.trackSettings[track].muted = !state.trackSettings[track].muted;
    mute.classList.toggle('active', state.trackSettings[track].muted);
    applyTrackSettings();
  }
  if (solo) {
    const track = solo.dataset.track;
    state.trackSettings[track].solo = !state.trackSettings[track].solo;
    solo.classList.toggle('active', state.trackSettings[track].solo);
    applyTrackSettings();
    document.querySelectorAll('.track-btn.solo').forEach(button => {
      button.classList.toggle('active', state.trackSettings[button.dataset.track].solo);
    });
  }
});

document.addEventListener('input', event => {
  const volume = event.target.closest('.track-volume');
  if (volume) {
    const track = volume.dataset.track;
    state.trackSettings[track].volume = volume.value / 100;
    applyTrackSettings();
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'reviewUsePreview') {
    togglePreview(event.target.checked);
  }
  if (event.target.id === 'reviewSourceAudio') {
    $('reviewVideo').muted = !event.target.checked;
  }
});

function init() {
  $('reviewPlay').addEventListener('click', () => setPlaying(!state.playing));
  $('applyChangesBtn').addEventListener('click', applyChanges);
  $('discardChangesBtn').addEventListener('click', discardChanges);

  const scrub = $('reviewScrub');
  scrub.addEventListener('input', () => {
    scrubbing = true;
    const time = scrub.value / 1000 * state.duration;
    $('reviewVideo').currentTime = time;
    $('timelinePlayhead').style.left = percent(time);
  });
  scrub.addEventListener('change', () => {
    scrubbing = false;
    if (state.playing && !$('reviewUsePreview').checked) {
      scheduleAudio($('reviewVideo').currentTime);
    }
  });

  const video = $('reviewVideo');
  video.addEventListener('ended', () => setPlaying(false));

  $('timelineBody').addEventListener('pointerdown', event => {
    if (event.target.closest('.audio-clip') || event.target.closest('.clip')) return;
    const rect = $('timelineRuler').getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const time = fraction * state.duration;
    $('reviewVideo').currentTime = time;
    $('timelinePlayhead').style.left = percent(time);
    if (state.playing && !$('reviewUsePreview').checked) {
      scheduleAudio(time);
    }
  });
}

// Module scripts can run before or after DOMContentLoaded depending on the
// browser; handle both cases.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.WhatIfTimeline = {
  load, refresh, togglePreview, applyChanges, markDirty, render,
  set onApplyChanges(fn) { window.__whatIfApplyChanges = fn; },
  get onApplyChanges() { return window.__whatIfApplyChanges; }
};
