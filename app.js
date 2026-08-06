const $ = (selector) => document.querySelector(selector);
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
const playBtn = $('#playBtn');
const progress = $('#progress');
const currentTime = $('#currentTime');
const tempo = $('#tempo');
const tempoValue = $('#tempoValue');
const playhead = $('#playhead');
const canvas = $('#pianoCanvas');
const context = canvas.getContext('2d');

let playing = false;
let elapsed = 0;
let timer;
let loopEnabled = true;
let loopData = null;
let audioContext = null;
let masterGain = null;
let scheduledSources = [];
let activeData = null;
const mutedTracks = new Set();
const colors = ['#e76d52', '#e2c15a', '#6f91b8', '#86aa81', '#d88cba', '#9b9bdb'];
let clockStartedAt = 0;
let clockOffset = 0;
let playRequest = 0;
let volumeMuted = false;
let loadRequest = 0;
let loopA = null;
let loopB = null;
let zoomScale = 1;
let soundProfile = 'piano';
const MAX_EVENTS = 500000;
const MAX_NOTES = 100000;
const MAX_SCHEDULED_SOURCES = 12000;

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function readString(view, offset, length) {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join('');
}

function readVar(view, state) {
  let value = 0;
  let byte;
  let count = 0;
  do {
    if (state.offset >= state.end || count >= 4) throw new Error('Invalid MIDI variable-length value');
    byte = view.getUint8(state.offset++);
    value = (value << 7) | (byte & 0x7f);
    count += 1;
  } while (byte & 0x80);
  return value;
}

function parseMidi(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 14 || readString(view, 0, 4) !== 'MThd') throw new Error('Missing MIDI header');
  const headerLength = view.getUint32(4);
  if (headerLength < 6 || 8 + headerLength > view.byteLength) throw new Error('Invalid MIDI header length');
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);
  if (format < 0 || format > 1) throw new Error('Only MIDI formats 0 and 1 are supported');
  if (trackCount === 0 || (format === 0 && trackCount !== 1)) throw new Error('Invalid MIDI track count');
  if (division & 0x8000) throw new Error('SMPTE MIDI timing is not supported yet');
  const ticksPerBeat = division;
  if (ticksPerBeat === 0) throw new Error('Invalid MIDI tick division');
  let offset = 8 + headerLength;
  const rawTracks = [];
  const tempoEvents = [{ tick: 0, microseconds: 500000 }];
  let eventCount = 0;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (offset + 8 > view.byteLength) throw new Error('MIDI track count does not match file');
    if (readString(view, offset, 4) !== 'MTrk') throw new Error('Invalid MIDI track');
    const length = view.getUint32(offset + 4);
    const end = offset + 8 + length;
    if (end > view.byteLength) throw new Error('MIDI track exceeds file bounds');
    const state = { offset: offset + 8, end };
    let tick = 0;
    let runningStatus = 0;
    let trackName = `Track ${trackIndex + 1}`;
    let program = 0;
    const events = [];
    let hasEndOfTrack = false;
    while (state.offset < end) {
      eventCount += 1;
      if (eventCount > MAX_EVENTS) throw new Error('MIDI file contains too many events');
      tick += readVar(view, state);
      if (state.offset >= end) throw new Error('Truncated MIDI event');
      let status = view.getUint8(state.offset++);
      if (status < 0x80) {
        state.offset -= 1;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }
      if (status === 0xff) {
        if (state.offset >= end) throw new Error('Truncated MIDI meta event');
        const metaType = view.getUint8(state.offset++);
        const metaLength = readVar(view, state);
        if (state.offset + metaLength > end) throw new Error('Truncated MIDI meta event');
        if (metaType === 0x03 && metaLength > 0) trackName = readString(view, state.offset, metaLength).replace(/[\0\x01-\x1f]/g, '').trim() || trackName;
        if (metaType === 0x51 && metaLength !== 3) throw new Error('Invalid MIDI tempo event');
        if (metaType === 0x51 && metaLength === 3) {
          const microseconds = (view.getUint8(state.offset) << 16) | (view.getUint8(state.offset + 1) << 8) | view.getUint8(state.offset + 2);
          if (microseconds === 0) throw new Error('Invalid MIDI tempo');
          tempoEvents.push({ tick, microseconds });
        }
        state.offset += metaLength;
        if (metaType === 0x2f) { if (metaLength !== 0) throw new Error('Invalid end-of-track event'); hasEndOfTrack = true; break; }
      } else if (status === 0xf0 || status === 0xf7) {
        const sysexLength = readVar(view, state);
        if (state.offset + sysexLength > end) throw new Error('Truncated MIDI sysex event');
        state.offset += sysexLength;
      } else if (status >= 0xf0) {
        const systemLength = status === 0xf1 || status === 0xf3 ? 1 : status === 0xf2 ? 2 : 0;
        if (state.offset + systemLength > end) throw new Error('Truncated MIDI system event');
        state.offset += systemLength;
      } else {
        const type = status >> 4;
        const channel = status & 0x0f;
        if (!runningStatus && status < 0x80) throw new Error('MIDI event has no running status');
        if (state.offset >= end) throw new Error('Truncated MIDI channel event');
        const first = view.getUint8(state.offset++);
        const second = type === 0xc || type === 0xd ? 0 : (() => { if (state.offset >= end) throw new Error('Truncated MIDI channel event'); return view.getUint8(state.offset++); })();
        if (first > 0x7f || second > 0x7f) throw new Error('Invalid MIDI channel data');
        if (type === 0xc) program = first;
        if (type === 0x9 && second > 0) events.push({ kind: 'on', tick, note: first, velocity: second, channel, program });
        if (type === 0x8 || (type === 0x9 && second === 0)) events.push({ kind: 'off', tick, note: first, channel });
      }
    }
    if (!hasEndOfTrack) throw new Error('MIDI track is missing end-of-track event');
    rawTracks.push({ name: trackName, program, events, endTick: tick });
    offset += 8 + length;
  }
  const tempos = tempoEvents.sort((a, b) => a.tick - b.tick).reduce((list, event) => {
    const previous = list[list.length - 1];
    if (previous && previous.tick === event.tick) list[list.length - 1] = event;
    else list.push(event);
    return list;
  }, []);
  const tickToSeconds = (targetTick) => {
    let seconds = 0;
    let previousTick = 0;
    let microseconds = tempos[0].microseconds;
    for (const event of tempos.slice(1)) {
      if (event.tick > targetTick) break;
      seconds += (event.tick - previousTick) * (microseconds / 1000000) / ticksPerBeat;
      previousTick = event.tick;
      microseconds = event.microseconds;
    }
    return seconds + (targetTick - previousTick) * (microseconds / 1000000) / ticksPerBeat;
  };
  let noteCount = 0;
  const tracks = rawTracks.map((raw, index) => {
    const open = new Map();
    const notes = [];
    raw.events.forEach((event) => {
      const key = `${event.channel}:${event.note}`;
      if (event.kind === 'on') open.set(key, [...(open.get(key) || []), event]);
      if (event.kind === 'off' && open.has(key)) {
        const starts = open.get(key);
        const start = starts.shift();
        notes.push({ start: tickToSeconds(start.tick), duration: Math.max(0.04, tickToSeconds(event.tick) - tickToSeconds(start.tick)), pitch: start.note, velocity: start.velocity / 127, channel: start.channel, color: colors[index % colors.length] });
        noteCount += 1;
        if (noteCount > MAX_NOTES) throw new Error('MIDI file contains too many notes');
        if (starts.length === 0) open.delete(key);
      }
    });
    const isDrumTrack = raw.events.some((event) => event.channel === 9);
    return { name: raw.name, instrument: isDrumTrack ? 'Drum Kit' : `Program ${raw.program}`, color: colors[index % colors.length], notes, muted: false };
  }).filter((track) => track.notes.length > 0);
  const duration = Math.max(1, ...rawTracks.map((track) => tickToSeconds(track.endTick)), ...tracks.flatMap((track) => track.notes.map((note) => note.start + note.duration)));
  if (offset !== view.byteLength) throw new Error('Unexpected data after MIDI tracks');
  return { format, ticksPerBeat, tracks, duration };
}

function makeDemoData() {
  const notes = [[32, 222, 74], [110, 190, 42], [148, 162, 65], [240, 126, 85], [358, 191, 52], [408, 98, 96], [520, 155, 64], [588, 72, 48], [650, 184, 120], [785, 130, 44], [850, 50, 38], [90, 240, 36], [300, 232, 55], [470, 220, 70], [715, 235, 76]];
  const trackNotes = notes.map(([x, y, width], index) => ({ start: x / 222 * 222, duration: Math.max(0.12, width / 36), pitch: Math.round(84 - y / 5), velocity: 0.65 + (index % 3) * 0.1, color: colors[index % 4] }));
  return { format: 1, tracks: [{ name: 'Piano', instrument: 'Acoustic Grand', color: colors[0], notes: trackNotes }], duration: 222 };
}

function updateProgress() {
  elapsed = Number(progress.value);
  currentTime.textContent = formatTime(elapsed);
  $('#durationLabel').textContent = formatTime(Number(progress.max));
  const labels = document.querySelectorAll('.time-labels span');
  labels.forEach((label, index) => { label.textContent = formatTime(Number(progress.max) * index / (labels.length - 1)); });
  const rollWidth = canvas.clientWidth || canvas.width;
  const markerPosition = (value) => value === null ? '' : `${38 + (value / Number(progress.max)) * rollWidth * zoomScale}px`;
  playhead.style.left = `${38 + (elapsed / Number(progress.max)) * rollWidth * zoomScale}px`;
  $('#markerA').style.left = markerPosition(loopA);
  $('#markerB').style.left = markerPosition(loopB);
  $('#markerA').classList.toggle('active', loopA !== null);
  $('#markerB').classList.toggle('active', loopB !== null);
  $('#aLabel').textContent = loopA === null ? '—' : formatTime(loopA);
  $('#bLabel').textContent = loopB === null ? '—' : formatTime(loopB);
  drawNotes();
}

function stopAudio() {
  scheduledSources.forEach((source) => { try { source.stop(); } catch (error) { /* already stopped */ } });
  scheduledSources = [];
}

function ensureAudio() {
  if (!window.AudioContext && !window.webkitAudioContext) return Promise.reject(new Error('Web Audio is not supported in this browser'));
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioContext.createGain();
    masterGain.gain.value = volumeMuted ? 0 : 0.18;
    masterGain.connect(audioContext.destination);
  }
  return audioContext.resume();
}

function scheduleAudio(fromSeconds, immediate = false, untilSeconds = activeData?.duration) {
  if (!activeData) return;
  stopAudio();
  const audioNow = audioContext.currentTime + (immediate ? 0 : 0.05);
  const tempoScale = Number(tempo.value) / 100;
  let sourceCount = 0;
  activeData.tracks.forEach((track, trackIndex) => {
    if (mutedTracks.has(trackIndex)) return;
    track.notes.forEach((note) => {
      const offset = note.start - fromSeconds;
      if (offset + note.duration <= 0) return;
      if (note.start >= untilSeconds) return;
      const start = audioNow + Math.max(0, offset) / tempoScale;
      const remaining = note.start + note.duration - Math.max(note.start, fromSeconds);
      const duration = Math.min(remaining + Math.min(0.1, remaining * 0.15), untilSeconds - Math.max(note.start, fromSeconds)) / tempoScale;
      if (duration <= 0) return;
      sourceCount += 1;
      if (sourceCount > MAX_SCHEDULED_SOURCES) throw new Error('This MIDI is too dense for browser preview');
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const profile = {
        piano: { type: trackIndex % 2 ? 'triangle' : 'sine', attack: 0.012, release: 0.15, level: 0.16 },
        keys: { type: 'triangle', attack: 0.025, release: 0.28, level: 0.13 },
        organ: { type: 'sine', attack: 0.045, release: 0.08, level: 0.1 },
      }[soundProfile];
      oscillator.type = profile.type;
      oscillator.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.01, note.velocity * profile.level), start + profile.attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(profile.attack, duration - profile.release));
      oscillator.connect(gain).connect(masterGain);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
      scheduledSources.push(oscillator);
    });
  });
}

function rescheduleAudio(fromSeconds, immediate = false) {
  try {
    scheduleAudio(fromSeconds, immediate, loopEnabled && loopB !== null ? loopB : activeData.duration);
  } catch (error) {
    stopPlayback('Playback stopped');
    $('#uploadSub').textContent = `Playback stopped: ${error.message}`;
  }
}

function stopPlayback(status = 'Ready') {
  playing = false;
  ++playRequest;
  window.clearInterval(timer);
  stopAudio();
  playBtn.textContent = '▶';
  playBtn.setAttribute('aria-label', 'Play');
  $('#transportStatus').textContent = status;
}

async function setPlaying(next) {
  if (next === playing) return;
  const request = ++playRequest;
  playing = next;
  playBtn.textContent = playing ? 'Ⅱ' : '▶';
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#transportStatus').textContent = playing ? 'Playing' : 'Paused';
  if (playing) {
    try {
      await ensureAudio();
      if (request !== playRequest || !playing) return;
    } catch (error) {
      if (request !== playRequest) return;
      playing = false;
      $('#transportStatus').textContent = 'Ready';
      playBtn.textContent = '▶';
      playBtn.setAttribute('aria-label', 'Play');
      $('#uploadSub').textContent = error.message;
      return;
    }
    try {
      scheduleAudio(elapsed, false, loopEnabled && loopB !== null ? loopB : activeData.duration);
    } catch (error) {
      stopPlayback('Ready');
      $('#uploadSub').textContent = `Playback unavailable: ${error.message}`;
      return;
    }
    clockOffset = elapsed;
    clockStartedAt = performance.now();
    timer = window.setInterval(() => {
      elapsed = clockOffset + (performance.now() - clockStartedAt) / 1000 * (Number(tempo.value) / 100);
      const loopEnd = loopEnabled && loopB !== null ? loopB : activeData.duration;
      if (elapsed >= loopEnd) {
        if (loopEnabled) {
          const loopStart = loopA === null ? 0 : loopA;
          elapsed = loopStart;
          clockOffset = loopStart;
          clockStartedAt = performance.now();
          try { scheduleAudio(loopStart, true, loopEnd); } catch (error) { stopPlayback('Ready'); $('#uploadSub').textContent = `Playback stopped: ${error.message}`; }
        }
        else { elapsed = activeData.duration; setPlaying(false); }
      }
      progress.value = String(elapsed);
      updateProgress();
    }, 50);
  } else {
    ++playRequest;
    window.clearInterval(timer);
    stopAudio();
  }
}

function drawNotes() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!activeData) return;
  const noteHeight = 9;
  activeData.tracks.forEach((track, trackIndex) => track.notes.forEach((note) => {
    const x = note.start / activeData.duration * canvas.width * zoomScale;
    const width = Math.max(3, note.duration / activeData.duration * canvas.width * zoomScale);
    const y = Math.max(8, Math.min(canvas.height - noteHeight - 5, (108 - note.pitch) / 48 * (canvas.height - 20)));
    context.globalAlpha = mutedTracks.has(trackIndex) ? 0.16 : 0.92;
    context.fillStyle = track.color;
    context.fillRect(x, y, width, noteHeight);
    if (elapsed >= note.start && elapsed <= note.start + note.duration) {
      context.strokeStyle = '#fff';
      context.lineWidth = 1;
      context.strokeRect(x, y, width, noteHeight);
    }
  }));
  context.globalAlpha = 1;
}

function renderTracks() {
  if (!activeData) return;
  const list = $('#trackList');
  list.innerHTML = '';
  activeData.tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = `track${index === 0 ? ' selected' : ''}`;
    row.dataset.track = track.name;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const color = document.createElement('span');
    color.className = 'track-color';
    color.style.background = track.color;
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = track.name;
    const instrument = document.createElement('small');
    instrument.textContent = track.instrument;
    details.append(name, instrument);
    const mute = document.createElement('button');
    mute.className = 'track-mute';
    mute.setAttribute('aria-label', `Mute ${track.name}`);
    mute.textContent = '◉';
    row.append(color, details, mute);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter') row.click(); });
    row.addEventListener('click', (event) => {
    if (event.target.closest('.track-mute')) { mutedTracks.has(index) ? mutedTracks.delete(index) : mutedTracks.add(index); row.classList.toggle('muted'); if (playing) rescheduleAudio(elapsed); drawNotes(); return; }
      list.querySelectorAll('.track').forEach((item) => item.classList.remove('selected'));
      row.classList.add('selected');
    });
    list.append(row);
  });
  $('.panel-label span').textContent = String(activeData.tracks.length);
}

function applyData(data, fileName = 'Nocturne in E♭ Major') {
  activeData = data;
  mutedTracks.clear();
  loopA = null;
  loopB = null;
  loopEnabled = true;
  zoomScale = 1;
  $('#loopBtn').classList.add('active');
  $('#loopBtn').setAttribute('aria-pressed', 'true');
  document.querySelectorAll('.practice-controls button').forEach((button) => button.classList.remove('active'));
  $('#zoomLevel').style.width = '20%';
  progress.max = String(data.duration);
  progress.value = '0';
  elapsed = 0;
  drawNotes();
  renderTracks();
  $('#songName').textContent = fileName;
  const localTag = document.createElement('span');
  localTag.className = 'sample-tag';
  localTag.textContent = fileName === 'Nocturne in E♭ Major' ? 'DEMO' : 'LOCAL';
  $('#songName').append(' ', localTag);
  $('#songDetail').textContent = `${data.tracks.length} tracks · ${formatTime(data.duration)} · ${fileName === 'Nocturne in E♭ Major' ? 'oscillator preview' : 'parsed in browser'}`;
  updateProgress();
}

async function loadFile(file) {
  if (!file) return;
  const request = ++loadRequest;
  if (!/\.midi?$/i.test(file.name)) { $('#uploadTitle').textContent = 'MIDI files only'; $('#uploadSub').textContent = 'Try a .mid or .midi file'; return; }
  if (file.size > 50 * 1024 * 1024) { $('#uploadTitle').textContent = 'File is too large'; $('#uploadSub').textContent = 'Please choose a MIDI file under 50MB'; return; }
  try {
    if (playing) await setPlaying(false);
    const data = parseMidi(await file.arrayBuffer());
    if (request !== loadRequest) return;
    $('#uploadTitle').textContent = file.name.replace(/\.midi?$/i, '');
    $('#uploadSub').textContent = `${(file.size / 1024).toFixed(1)} KB · parsed locally`; 
    applyData(data, file.name.replace(/\.midi?$/i, ''));
  } catch (error) {
    if (request !== loadRequest) return;
    $('#uploadTitle').textContent = 'Could not read this MIDI';
    $('#uploadSub').textContent = error.message;
  }
}

$('#chooseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (event) => loadFile(event.target.files[0]));
$('#demoBtn').addEventListener('click', async () => { ++loadRequest; if (playing) await setPlaying(false); $('#uploadTitle').textContent = 'Nocturne in E♭ Major'; $('#uploadSub').textContent = 'Demo file loaded · oscillator preview'; applyData(makeDemoData()); await setPlaying(true); });
['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (event) => loadFile(event.dataTransfer.files[0]));
playBtn.addEventListener('click', () => setPlaying(!playing));
  progress.addEventListener('input', () => { updateProgress(); if (playing) { clockOffset = elapsed; clockStartedAt = performance.now(); rescheduleAudio(elapsed); } });
tempo.addEventListener('input', () => { tempoValue.textContent = `${tempo.value}%`; if (playing) { setPlaying(false).then(() => setPlaying(true)); } });
$('#loopBtn').addEventListener('click', (event) => { loopEnabled = !loopEnabled; event.currentTarget.classList.toggle('active', loopEnabled); event.currentTarget.setAttribute('aria-pressed', String(loopEnabled)); if (playing) rescheduleAudio(elapsed); });
$('#prevBtn').addEventListener('click', () => { elapsed = 0; progress.value = '0'; clockOffset = 0; clockStartedAt = performance.now(); updateProgress(); if (playing) rescheduleAudio(0); });
$('#nextBtn').addEventListener('click', () => { elapsed = activeData.duration; progress.value = String(elapsed); updateProgress(); if (playing) setPlaying(false); });
$('#exportBtn').addEventListener('click', () => window.alert('MIDI export is planned after editing tools are connected.'));
$('#soundProfile').addEventListener('change', (event) => { soundProfile = event.currentTarget.value; if (playing) rescheduleAudio(elapsed); $('#uploadSub').textContent = `${event.currentTarget.options[event.currentTarget.selectedIndex].text} preview ready`; });
document.querySelector('.volume-btn').addEventListener('click', (event) => { volumeMuted = event.currentTarget.classList.toggle('muted'); if (masterGain) masterGain.gain.value = volumeMuted ? 0 : 0.18; });
  $('#setABtn').addEventListener('click', (event) => { loopA = Math.min(elapsed, activeData.duration - 0.01); if (loopB !== null && loopB <= loopA) { loopB = null; $('#setBBtn').classList.remove('active'); } event.currentTarget.classList.add('active'); updateProgress(); });
$('#setBBtn').addEventListener('click', (event) => { const minimum = loopA === null ? 0.01 : loopA + 0.01; loopB = Math.min(activeData.duration, Math.max(elapsed, minimum)); if (loopA !== null && loopB <= loopA) loopB = null; event.currentTarget.classList.add('active'); loopEnabled = true; $('#loopBtn').classList.add('active'); $('#loopBtn').setAttribute('aria-pressed', 'true'); updateProgress(); if (playing) rescheduleAudio(elapsed); });
$('#clearLoopBtn').addEventListener('click', () => { loopA = null; loopB = null; document.querySelectorAll('.practice-controls button').forEach((button) => button.classList.remove('active')); updateProgress(); if (playing) rescheduleAudio(elapsed); });
function changeZoom(delta) { zoomScale = Math.max(0.75, Math.min(2, zoomScale + delta)); $('#zoomLevel').style.width = `${(zoomScale - 0.75) / 1.25 * 100}%`; drawNotes(); }
$('#zoomIn').addEventListener('click', () => changeZoom(0.25));
$('#zoomOut').addEventListener('click', () => changeZoom(-0.25));
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach((item) => { item.classList.remove('active'); item.setAttribute('aria-selected', 'false'); }); tab.classList.add('active'); tab.setAttribute('aria-selected', 'true'); }));

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, button, a, [contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
  if (event.key === 'ArrowLeft') { progress.value = String(Math.max(0, Number(progress.value) - 5)); progress.dispatchEvent(new Event('input')); }
  if (event.key === 'ArrowRight') { progress.value = String(Math.min(Number(progress.max), Number(progress.value) + 5)); progress.dispatchEvent(new Event('input')); }
  if (event.key.toLowerCase() === 'a') $('#setABtn').click();
  if (event.key.toLowerCase() === 'b') $('#setBBtn').click();
});

applyData(makeDemoData());
