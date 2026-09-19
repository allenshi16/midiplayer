/*
 * GA4 loader (shared pattern across our static sites).
 *
 * Enabled only when the page carries a valid measurement id:
 *   <meta name="ga-measurement" content="G-XXXXXXXXXX" />
 * The value is injected at build time (Vite %VITE_GA_ID% on the SPA, or a
 * literal baked into generated pages). Without a valid id nothing loads.
 */
(function () {
  'use strict'
  var meta = document.querySelector('meta[name="ga-measurement"]')
  var id = meta ? (meta.getAttribute('content') || '').trim() : ''
  if (!/^G-[A-Z0-9]{6,}$/.test(id)) return

  if (!document.getElementById('gtag-loader')) {
    var s = document.createElement('script')
    s.id = 'gtag-loader'
    s.async = true
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id)
    document.head.appendChild(s)
  }

  window.dataLayer = window.dataLayer || []
  function gtag() { window.dataLayer.push(arguments) }
  gtag('js', new Date())
  gtag('config', id, { anonymize_ip: true })
})()
