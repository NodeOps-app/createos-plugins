#!/usr/bin/env bash
# dispatch.sh — Amp self-hosted orb provider backed by CreateOS Sandbox.
# Run with: amp orb provider /abs/path/dispatch.sh
# Contract: https://ampcode.com/docs/orbs/self-hosted#dispatch-contract
set -euo pipefail

shape="${CREATEOS_ORB_SHAPE:-s-4vcpu-8gb}"

# Sandbox names cap at 22 chars and ORB_ID (amp-<thread id>) is longer, so name by hash.
hash=$( (sha256sum 2>/dev/null || shasum -a 256) <<<"$ORB_ID")
name="amp-${hash:0:18}"

# Jobs can arrive while an earlier one is still settling (spawn right after pause),
# so wait out transitional states. 120 x 2 s stays inside Amp's five-minute job limit.
for _ in $(seq 120); do
	status=$(createos -o json sandbox get "$name" 2>/dev/null | jq -r .status) || status=""
	case "$status" in
	pausing | resuming | creating | forking) sleep 2 ;;
	*) break ;;
	esac
done

# CreateOS templates only build FROM nodeops/sandbox:*, so ORB_IMAGE cannot boot as-is.
# Instead give devbox:1 (Ubuntu, has git/node/tmux/rg/curl) what the orb image contract needs.
# Idempotent: a no-op after the first spawn.
# shellcheck disable=SC2016 # expands inside the sandbox
provision='set -e
grep -q "$(hostname)" /etc/hosts || echo "127.0.1.1 $(hostname)" >>/etc/hosts
if ! command -v sudo >/dev/null || ! command -v gh >/dev/null; then
	DEBIAN_FRONTEND=noninteractive apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo gh >/dev/null
fi
id user >/dev/null 2>&1 || useradd -m -s /bin/bash user
echo "user ALL=(ALL) NOPASSWD: ALL" >/etc/sudoers.d/user
if [ ! -x /usr/local/bin/amp ]; then
	tmp=$(mktemp -d)
	# HOME too, so the checksum-verifying installer edits no real shell profile.
	curl -fsSL https://ampcode.com/install.sh | HOME="$tmp" AMP_HOME="$tmp" bash >/dev/null
	install -m 755 "$(readlink -f "$tmp/bin/amp")" /usr/local/bin/amp
	rm -rf "$tmp"
fi
# A resumed snapshot still holds the previous bootstrap, connected with an old token.
# Anchored, so it cannot match this script, whose own command line holds the phrase.
pkill -f "^amp orb bootstrap" || true'

case "$ORB_OPERATION" in
spawn)
	case "$status" in
	running) ;;
	paused) createos sandbox resume "$name" ;;
	"" | destroyed | failed)
		[ "$status" != failed ] || createos sandbox rm "$name" --force
		# exec/process --env may only override keys declared here, so declare both.
		createos sandbox create --name "$name" --shape "$shape" --rootfs devbox:1 \
			--env ORB_TOKEN= --env AMP_URL=
		;;
	*)
		echo "sandbox $name is $status; refusing to guess" >&2
		exit 1
		;;
	esac
	createos sandbox exec "$name" --stream -- bash -c "$provision"
	# shellcheck disable=SC2016 # expands inside the sandbox
	createos sandbox process start "$name" \
		--env ORB_TOKEN="$ORB_TOKEN" --env AMP_URL="${AMP_URL-}" -- \
		sudo -u user -H --preserve-env=ORB_TOKEN,AMP_URL bash -lc \
		'[ -n "$AMP_URL" ] || unset AMP_URL; cd ~ && exec amp orb bootstrap'
	;;
pause)
	# CreateOS pause snapshots disk and memory. ORB_SNAPSHOT_ID is ignored, which the
	# contract allows: each new thread then boots fresh and runs .agents/setup.
	[ "$status" != running ] || createos sandbox pause "$name"
	;;
delete)
	case "$status" in
	"" | destroying | destroyed) ;;
	*) createos sandbox rm "$name" --force ;;
	esac
	;;
*)
	echo "unknown ORB_OPERATION: $ORB_OPERATION" >&2
	exit 1
	;;
esac
