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
menu_plist="$tmp/home/Library/LaunchAgents/com.factory.factory-delegator.menubar.plist"
plutil -lint "$plist"
plutil -lint "$menu_plist"
grep -q '<key>RunAtLoad</key>' "$plist"
grep -q '<key>KeepAlive</key>' "$plist"
grep -q "$tmp/home/Library/Logs/factory-delegator/runner.log" "$plist"
grep -q 'Factory Runner.app' "$menu_plist"

HOME="$tmp/home" PATH="$tmp/bin:$PATH" FACTORY_LAUNCHD_RENDER_ONLY=1 \
	sh "$root/packages/delegator/runner/launchd/install.sh" --app-only
app="$tmp/home/Applications/Factory Runner.app"
plutil -lint "$app/Contents/Info.plist"
[ -x "$app/Contents/MacOS/FactoryRunnerMenuBar" ]
[ -f "$app/Contents/Resources/runner/launchd/install.sh" ]
