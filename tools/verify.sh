#!/usr/bin/env bash
# One-shot verification: syntax gate, then the node suites, then a real browser against a
# real server driven over CDP. Everything this starts exits with the script, including the
# Chrome it launched on a throwaway profile.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates the cores and, with no CDP client attached, the process does not
# always exit on its own. This game is 2D canvas, so plain headless Chrome is enough.
#
#   ./tools/verify.sh                         # node suites + @boot @play @routes @save @pointer
#   SCENARIOS="pointer" ./tools/verify.sh     # one browser suite while editing the view
#   SKIP_UNIT=1 ./tools/verify.sh             # browser job in CI: the suites are their own job
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9346}
WEB_PORT=${WEB_PORT:-5186}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# One headless Chrome per machine, and it has to be this one. DevTools binds a port for the
# whole process, so a sibling repo's Chrome does not merely waste a core: a second instance
# either fails to bind $CDP_PORT (and then every eval in this script silently targets the
# *other* browser, whose pages do not contain this game) or steals the profile lock.
# Wait for the field to clear instead of losing the run.
busy_chrome() { ps -Ao command= | awk '/remote-debugging[-]port/ && !/--type=/' | wc -l | tr -d ' '; }  # instances, not procs
WAITED=0
while [ "$(busy_chrome)" != "0" ]; do
  echo "waiting for a sibling headless Chrome to exit (${WAITED}s, $(busy_chrome) browsers)"
  sleep "${CHROME_RETRY:-60}"
  WAITED=$((WAITED + ${CHROME_RETRY:-60}))
  [ "$WAITED" -ge "${CHROME_WAIT:-600}" ] && { echo "another Chrome still owns DevTools after ${WAITED}s; nothing was run" >&2; exit 6; }
done

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1280,860 --no-first-run --no-default-browser-check about:blank \
  >/tmp/eulertrail-chrome.log 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >/tmp/eulertrail-server.log 2>&1 &
SPID=$!
cleanup() {
  trap - EXIT
  kill -9 $CPID $SPID $WD 2>/dev/null
  for p in $CPID $SPID $WD; do wait $p 2>/dev/null; done
  rm -rf $UDD
}
WD=""
trap cleanup EXIT
# Watchdog redirects its fds: a background subshell inherits the script's stdout, and if
# this runs inside a pipeline it would hold the write end open for the full timeout and
# stall the consumer long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; echo "WATCHDOG: verify.sh exceeded ${WD_TIMEOUT:-420}s" >&2; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, and the web
# root answers only once server.cjs has opened its socket, so wait on both endpoints rather
# than guessing a sleep duration.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; tail -5 /tmp/eulertrail-chrome.log >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; tail -5 /tmp/eulertrail-server.log >&2; exit 4; }

cd "$HERE"
FAILED=0

echo "=== syntax ==="
npm run --silent check || FAILED=1

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" || FAILED=1
  done
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# The pool is 48 rows of measurement and the shell resolves a route before it reports a
# state id, so wait on window.eulertrail rather than on a timer: a fixed sleep under CI
# (cold module graph, no renderer) reads an unmounted page and every suite then "fails" at
# row one, with a canvas still at the 300x150 default.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.eulertrail?window.eulertrail.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.eulertrail never appeared at $BASE" >&2; exit 5; }

for s in ${SCENARIOS:-boot play routes save pointer}; do
  echo "=== @$s ==="
  node tools/playtest.mjs eval "@$s" nonav 2>&1 | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-300:]); sys.exit(1)
depth = 0
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            try: d = json.loads(raw[start:i + 1])
            except Exception as e:
                print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
            break
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", d.get("fail"))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:240])
sys.exit(1 if d.get("fail") else 0)
' || FAILED=1
  node tools/playtest.mjs shot "/tmp/eulertrail-$s.png" >/dev/null 2>&1
done

# Evidence shot of a finished level. The campaign's hardest-first first lot is a par 2 board,
# so the whole cover fits in two pens and the win card shows the theorem's own number. The
# route needs one tick to resolve (hashchange is async), hence the awaited load.
echo "=== win shot ==="
node tools/playtest.mjs eval \
  "(async () => { const g = window.eulertrail; g.store.reset(); g.load('#/lot/tandem-01'); await new Promise((r) => setTimeout(r, 400)); return { id: g.state.id, par: g.state.par, play: g.playAll(), grade: g.grade() }; })()" nonav | head -12
node tools/playtest.mjs shot "/tmp/eulertrail-win.png" >/dev/null 2>&1 && echo "wrote /tmp/eulertrail-win.png"

echo "=== console ==="
node tools/playtest.mjs logs
kill $WD 2>/dev/null
wait $WD 2>/dev/null
WD=""
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || { echo "=== FAILURES ABOVE ==="; echo "--- chrome log"; tail -3 /tmp/eulertrail-chrome.log; echo "--- server log"; tail -3 /tmp/eulertrail-server.log; }
exit $FAILED
