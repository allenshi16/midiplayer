#!/usr/bin/env node
/*
 * generate-track-pages.mjs
 * Reads scripts/track-data.json and produces:
 *   - public/songs/<slug>/index.html  (one indexable page per public-domain melody)
 *   - public/songs/songs-index.html   (hub page linking all tracks)
 *   - public/songs/demo-player.js     (shared self-contained WebAudio demo player)
 *   - updates public/sitemap.xml
 * Re-runnable: regenerates deterministically from the data file.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SITE_URL = 'https://midiplayeronline.com';
// Static site: webroot IS the repo root (index.html lives at root, no build step).
// Songs must be generated here so they deploy with the site.
const OUT_DIR = join(ROOT, 'songs');

const data = JSON.parse(await readFile(join(__dirname, 'track-data.json'), 'utf8'));
const tracks = data.tracks;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// MIDI note number -> note name (for display)
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const noteName = (pitch) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;

function durationSeconds(track) {
  const beatsPerSec = track.bpm / 60;
  let maxEnd = 0;
  for (const [start, , dur] of track.notes) maxEnd = Math.max(maxEnd, start + dur);
  return (maxEnd / beatsPerSec).toFixed(1);
}

function faq(track) {
  const n = track.notes.length;
  return [
    {
      q: `Can I play ${track.title} online in my browser?`,
      a: `Yes. Use the demo player above to hear this public-domain ${track.era} melody instantly, or drop your own MIDI file into the MIDI Player Online tool for full piano-roll playback, tempo control and A/B practice looping. Everything runs locally in your browser — no upload, account or install.`
    },
    {
      q: `Who composed ${track.title}?`,
      a: `${track.title} is ${track.composer === 'Traditional French melody' || track.composer === 'Traditional English folk song' || track.composer === 'Traditional Scottish song' ? 'a ' : ''}${track.composer} (${track.era}). It is in the public domain, so it can be freely arranged, performed and used.`
    },
    {
      q: `What key is ${track.title} usually played in?`,
      a: `This arrangement is written in ${track.key}. The demo above uses that key so you can hear the melody as traditionally performed.`
    },
    {
      q: `Is a MIDI file version of ${track.title} available?`,
      a: `Instead of downloading a file, you can hear the melody right here with the built-in player. To practice it, set a slow tempo and use the A/B loop to repeat a section. You can also export or record any MIDI you play from the main MIDI Room player.`
    }
  ];
}

function renderPage(track, prev, next) {
  const noteCount = track.notes.length;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicComposition',
    name: track.title,
    composer: { '@type': 'Person', name: track.composer },
    inLanguage: 'en',
    description: track.description,
    url: `${SITE_URL}/songs/${track.slug}/`
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq(track).map((f) => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }
    }))
  };
  const faqHtml = faq(track).map((f) => `
      <h3>${esc(f.q)}</h3>
      <p>${esc(f.a)}</p>`).join('\n');
  const nav = [prev, next].filter(Boolean).map((t) =>
    `<a class="song-nav-link" href="/songs/${t.slug}/">${esc(t.title)}</a>`).join(' · ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${esc(track.title)} by ${esc(track.composer)} — play this public-domain ${track.era} melody online instantly with MIDI Room's browser player. No upload, account or install." />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="canonical" href="${SITE_URL}/songs/${track.slug}/" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(track.title)} — Play Online" />
    <meta property="og:description" content="Hear ${esc(track.title)} instantly in your browser. Free, private, 100% local." />
    <meta property="og:url" content="${SITE_URL}/songs/${track.slug}/" />
    <meta property="og:image" content="${SITE_URL}/og-image.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(track.title)} — Play Online | MIDI Room" />
    <meta name="twitter:description" content="Play ${esc(track.title)} in your browser. No upload, no account, no install." />
    <title>${esc(track.title)} — Play Online | MIDI Room</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <script type="application/ld+json">${JSON.stringify(faqLd)}</script>
    <link rel="stylesheet" href="/styles.css" />
    <style>
      .song-page{max-width:960px;margin:0 auto;padding:64px 24px 90px}
      .song-page h1{font-size:clamp(34px,4.5vw,52px);letter-spacing:-.06em;margin:8px 0 6px;font-weight:800}
      .song-composer{font-family:var(--mono);color:var(--coral);font-size:12px;letter-spacing:.08em;margin-bottom:28px}
      .song-stats{display:flex;gap:26px;font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:34px;flex-wrap:wrap}
      .song-stats b{color:var(--ink);font-weight:600}
      .demo-shell{background:#242525;border-radius:14px;padding:26px;margin-bottom:40px}
      #demoCanvas{width:100%;height:220px;background:repeating-linear-gradient(to bottom,transparent 0,transparent 26px,#363a35 27px);border-radius:8px;display:block}
      .demo-controls{display:flex;align-items:center;gap:18px;margin-top:16px;flex-wrap:wrap}
      .demo-play{width:46px;height:46px;border-radius:50%;background:var(--coral);border:0;color:#fff;font-size:15px;cursor:pointer;box-shadow:0 0 0 5px rgba(231,109,82,.14)}
      .demo-progress{flex:1;accent-color:var(--coral);min-width:180px}
      .demo-time{font:11px var(--mono);color:#eee6d8;min-width:70px}
      .demo-hint{color:#8f938a;font-size:11px;font-family:var(--mono);margin-top:8px}
      .song-body h2{font-size:24px;letter-spacing:-.04em;margin:34px 0 12px}
      .song-body p{color:#5f5c55;line-height:1.8;font-size:14px;max-width:640px}
      .faq-grid{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin-top:8px}
      .faq-item{border-left:1px solid var(--line);padding-left:18px}
      .faq-item h3{font-size:14px;margin:0 0 8px;letter-spacing:-.02em}
      .faq-item p{font-size:12px;color:var(--muted);line-height:1.7;margin:0}
      .song-nav{margin-top:50px;padding-top:26px;border-top:1px solid var(--line);display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px}
      .song-nav a{color:var(--coral);text-decoration:none}
      .song-nav a:hover{text-decoration:underline}
      .back-home{display:inline-block;margin-bottom:26px;font-family:var(--mono);font-size:11px;color:var(--muted);text-decoration:none}
      .back-home:hover{color:var(--coral)}
      @media(max-width:700px){.faq-grid{grid-template-columns:1fr;gap:20px}.song-nav{flex-direction:column;gap:10px}}
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="MIDI Room home"><span class="brand-mark"><i></i><i></i><i></i><i></i></span><span>MIDI<span class="brand-dim">ROOM</span></span></a>
        <nav class="nav-links" aria-label="Main navigation"><a href="/">Player</a><a href="/songs/songs-index.html">Songs</a></nav>
      </header>
      <main class="song-page">
        <a class="back-home" href="/">← Back to MIDI Player Online</a>
        <h1>${esc(track.title)}</h1>
        <div class="song-composer">${esc(track.composer)} · ${esc(track.era)}</div>
        <div class="song-stats">
          <span>Key <b>${esc(track.key)}</b></span>
          <span>Tempo <b>${track.bpm} BPM</b></span>
          <span>Duration <b>${durationSeconds(track)}s</b></span>
          <span>Melody <b>${noteCount} notes</b></span>
        </div>

        <section class="demo-shell" aria-label="${esc(track.title)} demo player">
          <canvas id="demoCanvas"></canvas>
          <div class="demo-controls">
            <button class="demo-play" id="demoPlay" aria-label="Play ${esc(track.title)}">▶</button>
            <input class="demo-progress" id="demoProgress" type="range" min="0" max="100" value="0" aria-label="Seek" />
            <span class="demo-time" id="demoTime">0:00</span>
          </div>
          <div class="demo-hint">◇ Plays in your browser — no upload, no account, 100% local</div>
        </section>

        <article class="song-body">
          <h2>About this song</h2>
          <p>${esc(track.description)}</p>
          <h2>Play it in MIDI Room</h2>
          <p>This is a simplified single-line arrangement so you can hear the melody instantly. To play the full piece with a piano roll, multi-track view, tempo control and A/B practice looping, use the main <a href="/" style="color:var(--coral)">MIDI Player Online</a> tool with your own MIDI file.</p>
          <h2>Frequently asked questions</h2>
          <div class="faq-grid">
${faqHtml}
          </div>
        </article>

        <nav class="song-nav">
          <span>${prev ? `<a href="/songs/${prev.slug}/">← ${esc(prev.title)}</a>` : '<span></span>'}</span>
          <span>${next ? `<a href="/songs/${next.slug}/">${esc(next.title)} →</a>` : '<span></span>'}</span>
        </nav>
      </main>
      <footer><span>MIDI Room · play MIDI files online</span><span>100% local · free · no account</span></footer>
    </div>
    <script>
      window.TRACK_DATA = ${JSON.stringify({ title: track.title, bpm: track.bpm, notes: track.notes })};
    </script>
    <script src="/songs/demo-player.js"></script>
  </body>
</html>
`;
}

function renderHub(tracks) {
  const items = tracks.map((t) => `
      <a class="song-card" href="/songs/${t.slug}/">
        <span class="song-card-title">${esc(t.title)}</span>
        <span class="song-card-composer">${esc(t.composer)}</span>
      </a>`).join('\n');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Public Domain Songs — Play Online',
    description: 'Play public-domain classical and folk melodies instantly in your browser with MIDI Room.',
    url: `${SITE_URL}/songs/songs-index.html`
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Play public-domain classical and folk melodies online instantly — Für Elise, Ode to Joy, Canon in D and more, free and 100% local in your browser." />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="canonical" href="${SITE_URL}/songs/songs-index.html" />
    <meta property="og:title" content="Public Domain Songs — Play Online | MIDI Room" />
    <meta property="og:description" content="Hear famous public-domain melodies in your browser. Free, private, no install." />
    <meta property="og:url" content="${SITE_URL}/songs/songs-index.html" />
    <meta property="og:image" content="${SITE_URL}/og-image.png" />
    <title>Public Domain Songs — Play Online | MIDI Room</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <link rel="stylesheet" href="/styles.css" />
    <style>
      .hub-page{max-width:960px;margin:0 auto;padding:64px 24px 90px}
      .hub-page h1{font-size:clamp(34px,4.5vw,52px);letter-spacing:-.06em;margin:8px 0 10px;font-weight:800}
      .hub-sub{color:var(--muted);font-size:14px;line-height:1.7;max-width:620px;margin-bottom:40px}
      .song-cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}
      .song-card{border:1px solid var(--line);border-radius:10px;padding:20px 22px;text-decoration:none;transition:.15s;background:#fff}
      .song-card:hover{border-color:var(--coral);transform:translateY(-2px)}
      .song-card-title{display:block;font-size:17px;font-weight:700;color:var(--ink);letter-spacing:-.02em;margin-bottom:5px}
      .song-card-composer{display:block;font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.06em}
      .back-home{display:inline-block;margin-bottom:26px;font-family:var(--mono);font-size:11px;color:var(--muted);text-decoration:none}
      .back-home:hover{color:var(--coral)}
      @media(max-width:700px){.song-cards{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="MIDI Room home"><span class="brand-mark"><i></i><i></i><i></i><i></i></span><span>MIDI<span class="brand-dim">ROOM</span></span></a>
        <nav class="nav-links" aria-label="Main navigation"><a href="/">Player</a><a href="/songs/songs-index.html">Songs</a></nav>
      </header>
      <main class="hub-page">
        <a class="back-home" href="/">← Back to MIDI Player Online</a>
        <h1>Public Domain Songs</h1>
        <p class="hub-sub">Hear famous public-domain classical and folk melodies instantly in your browser. Each song page includes a built-in demo player, so you can listen before you download or practice.</p>
        <div class="song-cards">
${items}
        </div>
      </main>
      <footer><span>MIDI Room · play MIDI files online</span><span>100% local · free · no account</span></footer>
    </div>
  </body>
</html>
`;
}

// ---- demo-player.js (self-contained WebAudio, CSP-safe external file) ----
const demoPlayerJs = `(function () {
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
    btn.textContent = '\\u25B6';
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
`;

// ---- write demo-player.js ----
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'demo-player.js'), demoPlayerJs);

// ---- write track pages ----
for (let i = 0; i < tracks.length; i++) {
  const track = tracks[i];
  const prev = tracks[i - 1] || null;
  const next = tracks[i + 1] || null;
  const dir = join(OUT_DIR, track.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), renderPage(track, prev, next));
}

// ---- write hub ----
await writeFile(join(OUT_DIR, 'songs-index.html'), renderHub(tracks));

// ---- update sitemap (static site: sitemap lives at repo root, not public/) ----
const sitemapPath = join(ROOT, 'sitemap.xml');
let sitemap = await readFile(sitemapPath, 'utf8');
const songUrls = tracks
  .map((t) => `  <url>\n    <loc>${SITE_URL}/songs/${t.slug}/</loc>\n    <lastmod>2026-08-11</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>`)
  .join('\n');
const hubUrl = `  <url>\n    <loc>${SITE_URL}/songs/songs-index.html</loc>\n    <lastmod>2026-08-11</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>`;
// insert before closing </urlset>, avoiding duplicates
const urlsetIndex = sitemap.indexOf('</urlset>');
const existingSongBlock = sitemap.match(/  <url>\n    <loc>https:\/\/midiplayeronline\.com\/songs\/[^<]*<\/loc>[\s\S]*?<\/url>/g);
if (existingSongBlock && existingSongBlock.length) {
  // sitemap already generated — remove old song entries then re-add
  sitemap = sitemap.replace(/  <url>\n    <loc>https:\/\/midiplayeronline\.com\/songs\/[^<]*<\/loc>[\s\S]*?<\/url>\n/g, '');
}
const newBlock = songUrls + '\n' + hubUrl;
sitemap = sitemap.slice(0, urlsetIndex) + newBlock + '\n' + sitemap.slice(urlsetIndex);
await writeFile(sitemapPath, sitemap);

console.log(`Generated ${tracks.length} song pages + songs-index.html + demo-player.js`);
console.log(`Output: ${OUT_DIR}`);
let bytes = 0;
for (const t of tracks) bytes += (await readFile(join(OUT_DIR, t.slug, 'index.html'))).length;
console.log(`Total page bytes: ${bytes}`);