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

runner="$app/Contents/Resources/runner/runner.ts"
cli_runner=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist")
[ "$cli_runner" = "$runner" ]
case "$cli_runner" in "$root"/*) exit 1 ;; esac
for file in runner/runner.ts runner/launchd/install.sh runner/launchd/runner.plist job.ts parse-issue.ts; do
  [ -f "$app/Contents/Resources/$file" ]
done
HOME="$tmp/home" PATH="$tmp/bin:$PATH" FACTORY_LAUNCHD_RENDER_ONLY=1   sh "$app/Contents/Resources/runner/launchd/install.sh" --install-runner
bundled_runner=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist")
[ "$bundled_runner" = "$cli_runner" ]

# A failed build must leave the existing Runner LaunchAgent untouched.
cp "$plist" "$tmp/before.plist"
printf '#!/bin/sh\nexit 1\n' > "$tmp/bin/swiftc"
chmod +x "$tmp/bin/swiftc"
if HOME="$tmp/home" PATH="$tmp/bin:$PATH" FACTORY_LAUNCHD_RENDER_ONLY=1   sh "$root/packages/delegator/runner/launchd/install.sh"; then
  echo "installation accepted a failed build" >&2
  exit 1
fi
cmp "$plist" "$tmp/before.plist"
