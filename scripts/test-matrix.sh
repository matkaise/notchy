#!/usr/bin/env bash
# Runs scripts/check.sh and scripts/test-shell.sh against each supported GNOME
# release, each in its own container (tests/matrix/Dockerfile).
#
#   bash scripts/test-matrix.sh            # GNOME 47 48 49 50 51
#   bash scripts/test-matrix.sh 49 51      # only these
#
# NOTCHY_MATRIX_SUITE=check|shell|all (default all) picks the suites; the
# NOTCHY_TEST_*_ONLY variables of test-shell.sh are passed through. Logs,
# screenshots and the result per release land in tests/output/matrix/gnome-N.
#
# A release missing from metadata.json's shell-version would be refused by
# GNOME as out of date, so the package built inside the container lists the
# release under test. metadata.json in the repository is never changed.
set -euo pipefail
cd "$(dirname "$0")/.."
declare -A UBUNTU=([47]=24.10 [48]=25.04 [49]=25.10 [50]=26.04 [51]=26.10)
suite="${NOTCHY_MATRIX_SUITE:-all}"
if (($#)); then versions=("$@"); else versions=(47 48 49 50 51); fi
passthrough=()
while IFS='=' read -r name _; do passthrough+=(-e "$name"); done < <(env | grep -E '^NOTCHY_TEST_[A-Z_]+=' || true)

run_one() {
    local version=$1 base=${UBUNTU[$1]:-}
    if [[ -z "$base" ]]; then printf 'GNOME %s: not a supported release\n' "$version" >&2; return 2; fi
    local image="notchy-test:gnome-$version" out="tests/output/matrix/gnome-$version"
    rm -rf "$out"; mkdir -p "$out"
    docker build -q -t "$image" --build-arg "UBUNTU=$base" tests/matrix >"$out/build.log" 2>&1 || { cat "$out/build.log" >&2; return 1; }
    docker run -i --rm --shm-size=1g -e "SUITE=$suite" "${passthrough[@]}" \
        -v "$PWD:/src:ro" -v "$PWD/$out:/out" "$image" bash -s <<'EOF'
set -u
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
# The Shell connects to the system bus at startup (GNOME 51's time limits
# fail without one). A container has none; a private bus stands in for it,
# with no system services behind it.
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/system_bus_socket"
dbus-daemon --session --address="$DBUS_SYSTEM_BUS_ADDRESS" --fork --nopidfile
mkdir notchy && tar -C /src --exclude=./.git --exclude=./dist --exclude=./tests/output --exclude=./archive --exclude=./locale -cf - . | tar -C notchy -xf -
cd notchy
version="$(gnome-shell --version)"; major="$(sed -E 's/[^0-9]*([0-9]+).*/\1/' <<<"$version")"
printf '%s\n' "$version" > /out/version.txt
python3 - "$major" <<'PY'
import json, sys
meta = json.load(open('metadata.json'))
if sys.argv[1] not in meta['shell-version']: meta['shell-version'].append(sys.argv[1])
json.dump(meta, open('metadata.json', 'w'), indent=2)
PY
status=0
if [[ "$SUITE" != shell ]]; then bash scripts/check.sh > /out/check.log 2>&1; echo $? > /out/check.status; [[ $(cat /out/check.status) == 0 ]] || status=1; fi
if [[ "$SUITE" != check ]]; then
    timeout 1800 bash scripts/test-shell.sh > /out/shell-run.log 2>&1; echo $? > /out/shell.status; [[ $(cat /out/shell.status) == 0 ]] || status=1
    cp -a tests/output/. /out/ 2>/dev/null || true
fi
exit $status
EOF
}

declare -A result
for version in "${versions[@]}"; do
    printf '== GNOME %s (Ubuntu %s)\n' "$version" "${UBUNTU[$version]:-?}"
    result[$version]=FAILED
    if run_one "$version"; then
        # Every suite that was asked for must have reported, and reported success.
        ok=1
        [[ "$suite" == shell ]] || [[ "$(cat "tests/output/matrix/gnome-$version/check.status" 2>/dev/null)" == 0 ]] || ok=0
        [[ "$suite" == check ]] || [[ "$(cat "tests/output/matrix/gnome-$version/shell.status" 2>/dev/null)" == 0 ]] || ok=0
        ((ok)) && result[$version]=passed
    fi
    printf '   %s: %s\n' "$(cat "tests/output/matrix/gnome-$version/version.txt" 2>/dev/null || echo '?')" "${result[$version]}"
done
failed=0
printf '\nSummary\n'
for version in "${versions[@]}"; do
    printf '  GNOME %s: %s' "$version" "${result[$version]}"
    for part in check shell; do [[ -f "tests/output/matrix/gnome-$version/$part.status" ]] && printf '  (%s exit %s)' "$part" "$(cat "tests/output/matrix/gnome-$version/$part.status")"; done
    printf '\n'
    [[ "${result[$version]}" == passed ]] || failed=1
done
exit $failed
