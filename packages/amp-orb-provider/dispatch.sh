#!/usr/bin/env bash
# dispatch.sh — Amp self-hosted orb provider backed by CreateOS Sandbox.
# Run with: amp orb provider /abs/path/dispatch.sh
# Contract: https://ampcode.com/docs/orbs/self-hosted#dispatch-contract
set -euo pipefail

shape="${CREATEOS_ORB_SHAPE:-s-4vcpu-8gb}"
template="${CREATEOS_ORB_TEMPLATE:-amp-orb}"
here=$(cd "$(dirname "$0")" && pwd)

# Sandbox names cap at 22 chars and ORB_ID (amp-<thread id>) is longer, so name by hash.
hash=$( (sha256sum 2>/dev/null || shasum -a 256) <<<"$ORB_ID")
name="amp-${hash:0:18}"

# Prints the sandbox status, or nothing when it does not exist. Any other lookup
# failure (API down) fails the job: read as "absent", delete would skip the rm.
lookup() {
	local out
	if out=$(createos -o json sandbox get "$name" 2>/dev/null); then
		jq -r .status <<<"$out"
	elif ! grep -q "no sandbox matching" <<<"$out"; then
		echo "cannot look up sandbox $name: $out" >&2
		return 1
	fi
}

# Jobs can arrive while an earlier one is still settling (spawn right after pause),
# so wait out transitional states. 120 x 2 s stays inside Amp's five-minute job limit.
for _ in $(seq 120); do
	status=$(lookup)
	case "$status" in
	pausing | resuming | creating | forking) sleep 2 ;;
	*) break ;;
	esac
done
case "$status" in
pausing | resuming | creating | forking)
	echo "sandbox $name is still $status after 4 minutes" >&2
	exit 1
	;;
esac

# Prints the rootfs for a new orb. CreateOS templates only build FROM nodeops/sandbox:*,
# so ORB_IMAGE cannot boot as-is; ./Dockerfile rebuilds its contract instead. A missing
# template is built here. While it is not ready, boot devbox:1 and let $provision fill
# the gaps, so a slow or broken builder never fails the job (Amp allows five minutes).
pick_rootfs() {
	local st="" submitted=""
	for _ in $(seq 40); do # 40 x 3 s: leaves the fallback time to provision
		st=$(createos -o json sandbox template show "$template" 2>/dev/null | jq -r .status) || st=""
		case "$st" in
		ready) echo "$template" && return ;;
		failed) break ;;
		"")
			[ -z "$submitted" ] || break # submit was refused for good, e.g. template quota
			submitted=1
			# A refusal can also mean a concurrent spawn submitted it first; the next poll sees that.
			createos sandbox template submit "$template" -f "$here/Dockerfile" --no-follow >&2 || true
			;;
		esac
		sleep 3
	done
	echo "template $template is ${st:-missing}; booting devbox:1 instead." \
		"If it failed, see 'createos sandbox template logs $template', then rm it to rebuild." >&2
	echo devbox:1
}

# Makes any rootfs meet the orb image contract. Idempotent: a no-op on the template and
# after the first spawn. Keep the package list in sync with ./Dockerfile.
# shellcheck disable=SC2016 # expands inside the sandbox
provision='set -e
grep -q "$(hostname)" /etc/hosts || echo "127.0.1.1 $(hostname)" >>/etc/hosts
missing=""
for pair in git:git node:nodejs tmux:tmux sudo:sudo rg:ripgrep gh:gh curl:curl \
	ssh:openssh-client pkill:procps; do
	command -v "${pair%%:*}" >/dev/null || missing="$missing ${pair#*:}"
done
if [ -n "$missing" ]; then
	DEBIAN_FRONTEND=noninteractive apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates $missing >/dev/null
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
		createos sandbox create --name "$name" --shape "$shape" --rootfs "$(pick_rootfs)" \
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
