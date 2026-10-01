#!/usr/bin/env bash
# Production installer verification on Debian/Ubuntu (run as root in a clean VM/container):
# clean install -> first launch -> trial -> DB -> sale -> backup -> restart -> restore -> uninstall -> reinstall
set -euo pipefail
DEB="${1:-release/SaberMarko-POS-1.0.0-amd64.deb}"
UPDATE_DEB="${2:-}"
EXE="/opt/SaberMarko POS/sabermarko"
UD="$(mktemp -d /tmp/sbm-installed-XXXX)"
run() { SBM_EXECUTABLE="$EXE" SBM_TEST_USERDATA="$UD" SBM_PHASE="$1" SBM_EXPECT_VERSION="${2:-}" xvfb-run -a npx playwright test tests/e2e/installed.spec.ts; }
dpkg -r sabermarko >/dev/null 2>&1 || true
echo "== clean install"; dpkg -i "$DEB" >/dev/null 2>&1 || apt-get install -f -y >/dev/null; test -x "$EXE"
echo "== first launch"; run first
echo "== restart + restore"; run restart
echo "== uninstall"; dpkg -r sabermarko >/dev/null; test ! -e "$EXE"; test -f "$UD/data/store.db" && echo "   data kept after uninstall: OK"
echo "== reinstall"; dpkg -i "$DEB" >/dev/null 2>&1 || apt-get install -f -y >/dev/null
run reinstalled
if [ -n "$UPDATE_DEB" ]; then
  echo "== update (install newer version over the old one)"; dpkg -i "$UPDATE_DEB" >/dev/null
  run updated "$(dpkg-query -W -f='${Version}' sabermarko)"
fi
echo "ALL INSTALLER CHECKS PASSED"
