#!/bin/sh
set -eu

label=com.factory.factory-delegator.runner
domain="gui/$(id -u)"
config="${HOME:?HOME must be set}/.config/factory-delegator/config.json"
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
log_dir="$HOME/Library/Logs/factory-delegator"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
runner=$(CDPATH='' cd -- "$script_dir/.." && pwd)/runner.ts
template="$script_dir/runner.plist"

if [ "${1:-}" = --uninstall ]; then
	[ "$#" -eq 1 ] || { echo "usage: install.sh [--uninstall]" >&2; exit 2; }
	launchctl bootout "$domain/$label" 2>/dev/null || true
	rm -f "$plist"
	exit 0
fi
[ "$#" -eq 0 ] || { echo "usage: install.sh [--uninstall]" >&2; exit 2; }
[ -f "$config" ] || { echo "missing $config" >&2; exit 1; }
mode=$(stat -f '%Lp' "$config")
[ "$mode" = 600 ] || { echo "$config must have mode 600" >&2; exit 1; }
node=$(command -v node) || { echo "node is not on PATH" >&2; exit 1; }
orca=$(command -v orca) || { echo "orca is not on PATH" >&2; exit 1; }
mkdir -p "$agents" "$log_dir"
sed -e "s|{{NODE}}|$node|g" -e "s|{{RUNNER}}|$runner|g" \
	-e "s|{{PATH}}|$(dirname "$orca"):$(dirname "$node"):/usr/bin:/bin|g" \
	-e "s|{{LOG_DIR}}|$log_dir|g" "$template" > "$plist"
chmod 600 "$plist"
if [ "${FACTORY_LAUNCHD_RENDER_ONLY:-}" = 1 ]; then exit 0; fi
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
