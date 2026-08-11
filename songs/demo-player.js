(function () {
  var canvas = document.getElementById('demoCanvas');
  if (!canvas || !window.TRACK_DATA) return;
  var ctx = canvas.getContext('2d');
  var data = window.TRACK_DATA;
  var bpm = data.bpm || 100;
  var spb = 60 / bpm; // seconds per beat
  var notes = (data.notes || []).map(function (n) {
    return { start: n[0] * spb, pitch: n[1], duration: Math.max(0.15, n[2] * spb) };
  });
  var duration = notes.reduce(function (m, n) { return Math.max(m, n.start + n.duration); }, 1);
  var audio = null, master = null, playing = false, raf = 0, elapsed = 0, playStart = 0;
  var btn = document.getElementById('demoPlay');
  var range = document.getElementById('demoProgress');
  var timeEl = document.getElementById('demoTime');
  var colors = ['#e76d52', '#e2c15a', '#6f91b8', '#86aa81', '#d88cba', '#9b9bdb'];

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var w = canvas.width, h = canvas.height;
    var minP = 48, maxP = 84;
    var rangeP = maxP - minP;
    var pxPerSec = w / duration;
    notes.forEach(function (n, i) {
      var y = h - ((n.pitch - minP) / rangeP) * (h - 20) - 10;
      var x = n.start * pxPerSec;
      var nw = Math.max(3, n.duration * pxPerSec - 2);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(x, y, nw, 8);
    });
    if (playing) {
      var px = elapsed * pxPerSec;
      ctx.fillStyle = '#e76d52';
      ctx.fillRect(Math.min(w - 1, px), 0, 2, h);
    }
  }

  function ensureAudio() {
    if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audio = new AC();
    master = audio.createGain();
    master.gain.value = 0.5;
    master.connect(audio.destination);
    return true;
  }

  function schedule(from) {
    var now = audio.currentTime + 0.05;
    notes.forEach(function (n) {
      var t = now + Math.max(0, n.start - from);
      if (t < audio.currentTime) return;
      var osc = audio.createOscillator();
      var g = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * Math.pow(2, (n.pitch - 69) / 12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.1, n.duration));
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + n.duration + 0.05);
    });
  }

  function fmt(s) { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

  function tick() {
    elapsed = (performance.now() - playStart) / 1000;
    if (elapsed >= duration) { stop(); elapsed = duration; }
    range.value = String((elapsed / duration) * 100);
    timeEl.textContent = fmt(elapsed) + ' / ' + fmt(duration);
    draw();
    if (playing) raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!ensureAudio()) return;
    playStart = performance.now() - elapsed * 1000;
    schedule(elapsed);
    playing = true;
    btn.textContent = 'Ⅱ';
    btn.setAttribute('aria-label', 'Pause');
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    btn.textContent = '\u25B6';
    btn.setAttribute('aria-label', 'Play');
  }

  btn.addEventListener('click', function () {
    if (playing) { stop(); }
    else { if (elapsed >= duration) { elapsed = 0; } play(); }
  });

  range.addEventListener('input', function () {
    elapsed = (Number(range.value) / 100) * duration;
    timeEl.textContent = fmt(elapsed) + ' / ' + fmt(duration);
    if (playing) schedule(elapsed);
    draw();
  });

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    draw();
  }
  window.addEventListener('resize', resize);
  resize();
  timeEl.textContent = '0:00 / ' + fmt(duration);
  draw();
})();
