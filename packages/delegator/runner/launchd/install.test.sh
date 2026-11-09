#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home/.config/factory-delegator" "$tmp/bin"
printf '{}\n' > "$tmp/home/.config/factory-delegator/config.json"
chmod 600 "$tmp/home/.config/factory-delegator/config.json"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/orca"
chmod +x "$tmp/bin/orca"
HOME="$tmp/home" PATH="$tmp/bin:$PATH" FACTORY_LAUNCHD_RENDER_ONLY=1 \
	sh "$root/packages/delegator/runner/launchd/install.sh"
plist="$tmp/home/Library/LaunchAgents/com.factory.factory-delegator.runner.plist"
plutil -lint "$plist"
grep -q '<key>RunAtLoad</key>' "$plist"
grep -q '<key>KeepAlive</key>' "$plist"
grep -q "$tmp/home/Library/Logs/factory-delegator/runner.log" "$plist"
