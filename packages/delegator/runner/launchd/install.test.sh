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
plist="$tmp/home/Library/LaunchAgents/com.mcwestling.factory-delegator.runner.plist"
menu_plist="$tmp/home/Library/LaunchAgents/com.mcwestling.factory-delegator.menubar.plist"
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
for file in runner/runner.ts runner/launchd/install.sh runner/launchd/runner.plist job.ts parse-issue.ts contract.ts; do
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

# A staged build writes only the staging directory.
rm -f "$tmp/bin/swiftc"
staged="$tmp/staged.app"
HOME="$tmp/home" PATH="$tmp/bin:$PATH" sh "$root/packages/delegator/runner/launchd/install.sh" --build-app "$staged"
for file in runner/runner.ts runner/launchd/install.sh runner/launchd/runner.plist menubar/menubar.plist job.ts parse-issue.ts contract.ts; do
  cmp "$staged/Contents/Resources/$file" "$root/packages/delegator/$file"
done
[ -x "$staged/Contents/MacOS/FactoryRunnerMenuBar" ]
cmp "$plist" "$tmp/before.plist"

# The build stamps its time in UTC, which the menu shows as "Build: <time>".
before=$(date -u '+%Y-%m-%d %H:%M UTC')
HOME="$tmp/home" PATH="$tmp/bin:$PATH" sh "$root/packages/delegator/runner/launchd/install.sh" --build-app "$staged"
after=$(date -u '+%Y-%m-%d %H:%M UTC')
built=$(/usr/libexec/PlistBuddy -c 'Print :FactoryBuildTime' "$staged/Contents/Info.plist")
[ "$built" = "$before" ] || [ "$built" = "$after" ] || { echo "build time $built isn't $before" >&2; exit 1; }

# Reinstalling quits the running menu bar app before its LaunchAgent opens it again,
# and a missing app (pkill exit 1) isn't an error, but a failed pkill is.
log="$tmp/calls"
printf '#!/bin/sh\necho "launchctl $*" >> "%s"\n' "$log" > "$tmp/bin/launchctl"
printf '#!/bin/sh\necho "pkill $*" >> "%s"\nexit "${FAKE_PKILL_EXIT:-0}"\n' "$log" > "$tmp/bin/pkill"
chmod +x "$tmp/bin/launchctl" "$tmp/bin/pkill"
for option in "" --app-only; do
  for code in 0 1; do
    : > "$log"
    HOME="$tmp/home" PATH="$tmp/bin:$PATH" FAKE_PKILL_EXIT=$code \
      sh "$root/packages/delegator/runner/launchd/install.sh" $option
    quit=$(grep -n "^pkill -U $(id -u) -x FactoryRunnerMenuBar$" "$log" | cut -d: -f1)
    boot=$(grep -n "^launchctl bootstrap .*menubar.plist$" "$log" | cut -d: -f1)
    [ -n "$quit" ] && [ "$quit" -lt "$boot" ] || { echo "install.sh $option didn't quit the app first" >&2; cat "$log" >&2; exit 1; }
  done
  if HOME="$tmp/home" PATH="$tmp/bin:$PATH" FAKE_PKILL_EXIT=2 \
    sh "$root/packages/delegator/runner/launchd/install.sh" $option; then
    echo "install.sh $option accepted a failed pkill" >&2
    exit 1
  fi
done
