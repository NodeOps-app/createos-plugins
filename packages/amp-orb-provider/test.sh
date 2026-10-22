#!/usr/bin/env bash
# test.sh — live end-to-end check of dispatch.sh against CreateOS. Creates and
# destroys one real sandbox. ORB_TOKEN is fake, so Amp rejecting it proves the
# token reached `amp orb bootstrap` as the orb's user.
# Checks are eval'd strings, so their expansions and helper calls are deferred on purpose.
# shellcheck disable=SC2016,SC2329
set -uo pipefail
cd "$(dirname "$0")" || exit

export ORB_ID="amp-T-selftest-$RANDOM$RANDOM" ORB_TOKEN=fake-token ORB_IMAGE=ignored
hash=$( (sha256sum 2>/dev/null || shasum -a 256) <<<"$ORB_ID")
name="amp-${hash:0:18}"
fails=0

check() {
	: >"$seen"
	if eval "$2"; then echo "ok   $1"; else echo "FAIL $1 (status seen: $(tr '\n' ' ' <"$seen"))"; fails=$((fails + 1)); fi
}
op() {
	local start=$SECONDS
	ORB_OPERATION=$1 ./dispatch.sh >"$log" 2>&1
	local rc=$?
	took=$((SECONDS - start))
	[ "$rc" = 0 ] || [ "$1" = bogus ] || sed 's/\x1b\[[0-9;]*m//g' "$log" | tr '\r' '\n' | grep -v '^\s*$' | tail -8 >&2
	return "$rc"
}
status() { createos -o json sandbox get "$name" 2>/dev/null | jq -r .status | tee -a "$seen"; }
in_box() { createos sandbox exec "$name" -- bash -c "$1"; }
# Replays what the bootstrap started by the last spawn printed before it exited.
bootstrap_output() {
	local pid
	pid=$(grep -o '"process_id": "[^"]*' "$log" | cut -d'"' -f4)
	sleep 5
	createos sandbox process attach "$name" "$pid" --no-follow --raw 2>&1
}
log=$(mktemp) seen=$(mktemp)
trap 'ORB_OPERATION=delete ./dispatch.sh >/dev/null 2>&1; rm -f "$log" "$seen"' EXIT

echo "orb $ORB_ID -> sandbox $name"
check "delete with no sandbox exits 0" 'op delete'
check "pause with no sandbox exits 0" 'op pause'
check "unknown operation exits non-zero" '! op bogus'

check "fresh spawn exits 0" 'op spawn || { tail -20 "$log"; false; }'
check "fresh spawn under 5 min (${took}s)" '[ "$took" -lt 300 ]'
check "sandbox is running" '[ "$(status)" = running ]'
check "amp at /usr/local/bin/amp" 'in_box "/usr/local/bin/amp --version" >/dev/null'
check "user has passwordless sudo" 'in_box "sudo -u user sudo -n true"'
check "user home is writable" 'in_box "sudo -u user test -w /home/user"'
check "gh, git, node, tmux, rg, curl present" 'in_box "command -v gh git node tmux rg curl" >/dev/null'
check "hostname resolves" 'in_box "getent hosts \$(hostname)" >/dev/null'
check "root shell profile untouched" '! in_box "grep -q \"Amp CLI\" /root/.bashrc"'
check "bootstrap got ORB_TOKEN and reached Amp" 'bootstrap_output | grep -q "ORB_TOKEN was rejected"'

# Stand-in for a bootstrap left running from before a pause.
in_box 'sudo -u user setsid bash -c "exec -a \"amp orb bootstrap\" sleep 9999" </dev/null >/dev/null 2>&1 &'
check "stale bootstrap stand-in is running" 'in_box "pgrep -f \"^amp orb bootstrap\"" >/dev/null'
check "repeat spawn exits 0" 'op spawn'
check "repeat spawn is fast (${took}s)" '[ "$took" -lt 60 ]'
check "repeat spawn killed the stale bootstrap" '! in_box "pgrep -f \"^amp orb bootstrap\" | grep -q ."'
check "spawn with AMP_URL exits 0" 'AMP_URL=http://127.0.0.1:9 op spawn'
check "bootstrap used AMP_URL" 'bootstrap_output | grep -q "Cannot reach Amp"'

in_box 'echo kept >/home/user/marker'
in_box 'setsid bash -c "exec -a memtest-sleeper sleep 9999" </dev/null >/dev/null 2>&1 &'
check "pause exits 0" 'op pause'
check "sandbox is paused (${took}s)" '[ "$(status)" = paused ]'
check "repeat pause exits 0" 'op pause'
check "spawn resumes paused sandbox" 'op spawn'
check "resume under 5 min (${took}s)" '[ "$took" -lt 300 ]'
check "sandbox is running again" '[ "$(status)" = running ]'
check "disk survived pause" '[ "$(in_box "cat /home/user/marker")" = kept ]'

check "memory survived pause (process alive)" 'in_box "pgrep -f ^memtest-sleeper" >/dev/null'

# Races: Amp may send the next job while the previous one is still settling.
ORB_OPERATION=pause ./dispatch.sh >/dev/null 2>&1 &
sleep 5
check "status mid-pause is pausing" '[ "$(status)" = pausing ]'
check "spawn during pausing exits 0" 'op spawn'
wait
check "sandbox is running after the race" '[ "$(status)" = running ]'

ORB_OPERATION=pause ./dispatch.sh >/dev/null 2>&1
ORB_OPERATION=spawn ./dispatch.sh >/dev/null 2>&1 &
sleep 5
check "pause during resuming exits 0" 'op pause'
wait
check "sandbox is paused after the race" '[ "$(status)" = paused ]'

check "delete exits 0" 'op delete'
check "sandbox is destroying or destroyed" '[[ "$(status)" == destroy* ]]'
check "repeat delete exits 0" 'op delete'

echo "$fails failure(s)"
exit $((fails > 0))
