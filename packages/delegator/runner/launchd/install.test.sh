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
# Agents from before the com.mcwestling rename are retired before the new ones install.
agents="$tmp/home/Library/LaunchAgents"
mkdir -p "$agents"
for name in runner menubar; do
  printf '<string>com.factory.factory-delegator.%s</string>\n' "$name" > "$agents/com.factory.factory-delegator.$name.plist"
done
HOME="$tmp/home" PATH="$tmp/bin:$PATH" FACTORY_LAUNCHD_RENDER_ONLY=1 \
	sh "$root/packages/delegator/runner/launchd/install.sh"
plist="$agents/com.mcwestling.factory-delegator.runner.plist"
menu_plist="$agents/com.mcwestling.factory-delegator.menubar.plist"
[ "$(ls "$agents")" = "$(printf 'com.mcwestling.factory-delegator.menubar.plist\ncom.mcwestling.factory-delegator.runner.plist')" ]
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

# A mode that renders only the Runner still carries the old menu bar agent over to its new label.
rm "$menu_plist"
printf '<string>com.factory.factory-delegator.menubar</string>\n' > "$agents/com.factory.factory-delegator.menubar.plist"
HOME="$tmp/home" PATH="$tmp/bin:$PATH" FACTORY_LAUNCHD_RENDER_ONLY=1   sh "$app/Contents/Resources/runner/launchd/install.sh" --install-runner
[ ! -e "$agents/com.factory.factory-delegator.menubar.plist" ]
grep -qx '<string>com.mcwestling.factory-delegator.menubar</string>' "$menu_plist"
[ "$(stat -f '%Lp' "$menu_plist")" = 600 ]

# A failed build must leave the existing Runner LaunchAgent untouched.
cp "$plist" "$tmp/before.plist"
printf '#!/bin/sh\nexit 1\n' > "$tmp/bin/swiftc"
chmod +x "$tmp/bin/swiftc"
if HOME="$tmp/home" PATH="$tmp/bin:$PATH" FACTORY_LAUNCHD_RENDER_ONLY=1   sh "$root/packages/delegator/runner/launchd/install.sh"; then
  echo "installation accepted a failed build" >&2
  exit 1
fi
cmp "$plist" "$tmp/before.plist"

# A staged build writes only the staging directory.
rm -f "$tmp/bin/swiftc"
staged="$tmp/staged.app"
HOME="$tmp/home" PATH="$tmp/bin:$PATH" sh "$root/packages/delegator/runner/launchd/install.sh" --build-app "$staged"
for file in runner/runner.ts runner/launchd/install.sh runner/launchd/runner.plist menubar/menubar.plist job.ts parse-issue.ts; do
  cmp "$staged/Contents/Resources/$file" "$root/packages/delegator/$file"
done
[ -x "$staged/Contents/MacOS/FactoryRunnerMenuBar" ]
cmp "$plist" "$tmp/before.plist"
