#!/usr/bin/env bash
# IndexNow submission for midiplayeronline.com
# Pings IndexNow (which propagates to Bing, Yandex, Seznam, Naver, etc.) with
# every URL found in the site's live sitemap.
#
# IMPORTANT: run this AFTER deploying, so the key file is publicly reachable at
#            https://midiplayeronline.com/e96aba22d2815188852128f6757d1f3f.txt  (IndexNow validates it before accepting).
#
# Usage:
#   bash scripts/indexnow-submit.sh
#   bash scripts/indexnow-submit.sh https://midiplayeronline.com/some-other-sitemap.xml
#   HTTPS_PROXY=http://127.0.0.1:10809 bash scripts/indexnow-submit.sh   # if you need a proxy
set -euo pipefail

HOST="midiplayeronline.com"
KEY="e96aba22d2815188852128f6757d1f3f"
KEY_LOCATION="https://${HOST}/${KEY}.txt"
ENDPOINT="https://api.indexnow.org/indexnow"
SITEMAP="${1:-https://${HOST}/sitemap.xml}"

# Extract <loc> URLs from sitemap XML on stdin (whitespace/newline tolerant).
extract_locs() {
  perl -0777 -ne 'while(/<loc>\s*(.*?)\s*<\/loc>/gs){$u=$1;$u=~s/\s+//g;print "$u\n" if $u=~m#^https?://#}'
}

TMP="$(mktemp)"
RESP="$(mktemp)"
trap 'rm -f "$TMP" "$RESP"' EXIT

XML="$(curl -fsSL "$SITEMAP")"
if printf '%s' "$XML" | grep -q '<sitemapindex'; then
  printf '%s' "$XML" | extract_locs | while read -r sm; do
    curl -fsSL "$sm" | extract_locs
  done | awk '!seen[$0]++' > "$TMP"
else
  printf '%s' "$XML" | extract_locs | awk '!seen[$0]++' > "$TMP"
fi

COUNT="$(wc -l < "$TMP" | tr -d ' ')"
if [ "$COUNT" -eq 0 ]; then
  echo "ERROR: no URLs parsed from $SITEMAP" >&2
  exit 1
fi
echo "Found $COUNT URL(s) for $HOST — submitting to IndexNow..."

python3 -c '
import json, sys
host, key, kloc, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
urls = [l.strip() for l in open(path) if l.strip()]
sys.stdout.write(json.dumps({"host": host, "key": key, "keyLocation": kloc, "urlList": urls}))
' "$HOST" "$KEY" "$KEY_LOCATION" "$TMP" \
| curl -s -o "$RESP" -w '%{http_code}' -X POST "$ENDPOINT" \
    -H 'Content-Type: application/json; charset=utf-8' --data @- > "${RESP}.code"

CODE="$(cat "${RESP}.code")"
echo "HTTP $CODE"
[ -s "$RESP" ] && { cat "$RESP"; echo; }
rm -f "${RESP}.code"
case "$CODE" in
  200|202) echo "OK: submission accepted. Bing will re-crawl these URLs.";;
  400)     echo "Bad request — check the URL list format.";;
  403)     echo "Invalid key — is https://${HOST}/${KEY}.txt live and exactly equal to the key?";;
  422)     echo "Unprocessable — key/keyLocation mismatch, or some URLs are not on this host.";;
  429)     echo "Rate limited — wait and retry.";;
  *)       echo "Unexpected response code.";;
esac
