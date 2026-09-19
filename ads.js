/*
 * AdSense loader (shared pattern across our static sites).
 *
 * Enabled only when the page carries a real publisher id:
 *   <meta name="adsense-client" content="ca-pub-XXXXXXXXXXXXXXXX" />
 * The token is injected at build time (Vite %VITE_ADSENSE_CLIENT% on the SPA,
 * or a literal value baked into generated pages). Without a valid id this file
 * hides every .ad-slot container and loads nothing — safe to ship pre-approval.
 *
 * With a valid id it enables Auto Ads; containers with a data-ad-slot attribute
 * are hydrated as manual display units on top of that.
 */
(function () {
  'use strict'
  var meta = document.querySelector('meta[name="adsense-client"]')
  var client = meta ? (meta.getAttribute('content') || '').trim() : ''
  if (!/^ca-pub-\d{10,}$/.test(client)) {
    document.querySelectorAll('.ad-slot').forEach(function (el) { el.style.display = 'none' })
    return
  }

  if (!document.getElementById('adsbygoogle-loader')) {
    var s = document.createElement('script')
    s.id = 'adsbygoogle-loader'
    s.async = true
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(client)
    s.crossOrigin = 'anonymous'
    document.head.appendChild(s)
  }

  function initAdSlots() {
    document.querySelectorAll('.ad-slot[data-ad-slot]:not([data-ad-ready])').forEach(function (el) {
      if (!el.getAttribute('data-ad-slot')) return
      el.setAttribute('data-ad-ready', '1')
      var ins = document.createElement('ins')
      ins.className = 'adsbygoogle'
      ins.style.display = 'block'
      ins.setAttribute('data-ad-client', client)
      ins.setAttribute('data-ad-slot', el.getAttribute('data-ad-slot'))
      ins.setAttribute('data-ad-format', 'auto')
      ins.setAttribute('data-full-width-responsive', 'true')
      el.appendChild(ins)
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}) } catch (e) { /* script not loaded yet */ }
    })
  }

  window.initAdSlots = initAdSlots
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdSlots)
  } else {
    initAdSlots()
  }
})()
