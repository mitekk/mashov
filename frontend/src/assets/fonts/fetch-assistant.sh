#!/usr/bin/env bash
#
# Re-download the Assistant subsets that `frontend/src/app/layout.tsx` loads.
#
# Run this BY HAND when the font needs updating -- never from a build. The
# whole point of committing the .woff2 files is that `next build` touches the
# network only for `npm ci`; calling this from the build would undo that.
#
# It prints each subset's `unicode-range` at the end. Those ranges are
# duplicated in `layout.tsx` (one `declarations` entry per localFont call),
# and Google does change them between font versions -- so diff the printed
# ranges against the file and update both together. See ./README.md.
#
# Requires: curl, python3. No npm dependency, no font tooling.

set -euo pipefail

cd "$(dirname "$0")"

FAMILY='Assistant:wght@300..700'
# Google serves .ttf to clients it does not recognise as woff2-capable, so a
# modern browser User-Agent is mandatory here, not cosmetic.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

declare -a SUBSETS=(hebrew latin latin-ext)

css="$(curl -sS --fail -A "$UA" \
  "https://fonts.googleapis.com/css2?family=${FAMILY}&display=swap")"

printf '%s\n' "$css" > /dev/null  # fail early if the fetch produced nothing

for subset in "${SUBSETS[@]}"; do
  url="$(printf '%s' "$css" | python3 -I -c '
import re, sys
css, subset = sys.stdin.read(), sys.argv[1]
blocks = re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{[^}]*\})", css)
for name, block in blocks:
    if name == subset:
        m = re.search(r"url\((https://[^)]+\.woff2)\)", block)
        if not m:
            sys.exit(f"no woff2 url in the {subset} block")
        print(m.group(1))
        break
else:
    sys.exit(f"subset {subset} not found in the served CSS")
' "$subset")"

  curl -sS --fail -A "$UA" -o "assistant-${subset}.woff2" "$url"
  printf 'assistant-%s.woff2  %s bytes\n' "$subset" "$(wc -c < "assistant-${subset}.woff2" | tr -d ' ')"
done

curl -sS --fail -o OFL.txt \
  'https://raw.githubusercontent.com/google/fonts/main/ofl/assistant/OFL.txt'
printf 'OFL.txt  %s bytes\n' "$(wc -c < OFL.txt | tr -d ' ')"

echo
echo 'unicode-range values -- these must match layout.tsx:'
printf '%s' "$css" | python3 -I -c '
import re, sys
css = sys.stdin.read()
for name, block in re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{[^}]*\})", css):
    if name in ("hebrew", "latin", "latin-ext"):
        m = re.search(r"unicode-range:\s*([^;]+);", block)
        print(f"  {name}: {m.group(1).strip() if m else '"'"'(none)'"'"'}")
'
