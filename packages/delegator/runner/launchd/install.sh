#!/bin/sh
set -eu

label=com.factory.factory-delegator.runner
menu_label=com.factory.factory-delegator.menubar
domain="gui/$(id -u)"
config="${HOME:?HOME must be set}/.config/factory-delegator/config.json"
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
menu_plist="$agents/$menu_label.plist"
app="$HOME/Applications/Factory Runner.app"
log_dir="$HOME/Library/Logs/factory-delegator"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
runner="$app/Contents/Resources/runner/runner.ts"
template="$script_dir/runner.plist"
menu_template="$package_dir/menubar/menubar.plist"
menubar_dir="$package_dir/menubar"

render_runner() {
	[ -f "$runner" ] || { echo "install the app first with --app-only" >&2; exit 1; }
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
}

render_menu() {
	mkdir -p "$agents"
	sed "s|{{APP}}|$app|g" "$menu_template" > "$menu_plist"
	chmod 600 "$menu_plist"
}

build_app() {
	resources="$app/Contents/Resources"
	mkdir -p "$app/Contents/MacOS" "$resources/runner/launchd" "$resources/menubar"
	swiftc -O -target "$(uname -m)-apple-macosx14.0" "$menubar_dir/Status.swift" "$menubar_dir/App.swift" -o "$app/Contents/MacOS/FactoryRunnerMenuBar"
	cp "$menubar_dir/Info.plist" "$app/Contents/Info.plist"
	cp "$package_dir/job.ts" "$package_dir/parse-issue.ts" "$resources/"
	cp "$package_dir/runner/runner.ts" "$resources/runner/"
	cp "$script_dir/install.sh" "$script_dir/runner.plist" "$resources/runner/launchd/"
	cp "$menu_template" "$resources/menubar/menubar.plist"
}

start_runner() {
	[ -f "$plist" ] || { echo "Runner isn't installed" >&2; exit 1; }
	launchctl enable "$domain/$label"
	launchctl bootstrap "$domain" "$plist"
}

case "${1:-}" in
	--uninstall)
		[ "$#" -eq 1 ] || { echo "usage: install.sh [--app-only|--install-runner|--uninstall-runner|--uninstall]" >&2; exit 2; }
		launchctl disable "$domain/$label" 2>/dev/null || true
		launchctl bootout "$domain/$label" 2>/dev/null || true
		launchctl disable "$domain/$menu_label" 2>/dev/null || true
		launchctl bootout "$domain/$menu_label" 2>/dev/null || true
		rm -f "$plist" "$menu_plist"
		rm -rf "$app"
		exit 0 ;;
	--uninstall-runner)
		[ "$#" -eq 1 ] || { echo "usage: install.sh --uninstall-runner" >&2; exit 2; }
		launchctl disable "$domain/$label" 2>/dev/null || true
		launchctl bootout "$domain/$label" 2>/dev/null || true
		rm -f "$plist"
		exit 0 ;;
	--stop-runner)
		[ "$#" -eq 1 ] || { echo "usage: install.sh --stop-runner" >&2; exit 2; }
		launchctl disable "$domain/$label"
		launchctl bootout "$domain/$label" 2>/dev/null || true
		exit 0 ;;
	--start-runner)
		[ "$#" -eq 1 ] || { echo "usage: install.sh --start-runner" >&2; exit 2; }
		start_runner
		exit 0 ;;
	--install-runner)
		[ "$#" -eq 1 ] || { echo "usage: install.sh --install-runner" >&2; exit 2; }
		render_runner
		[ "${FACTORY_LAUNCHD_RENDER_ONLY:-}" = 1 ] && exit 0
		start_runner
		exit 0 ;;
	--enable-app-login)
		[ "$#" -eq 1 ] || { echo "usage: install.sh --enable-app-login" >&2; exit 2; }
		[ -f "$menu_plist" ] || render_menu
		launchctl enable "$domain/$menu_label"
		launchctl bootstrap "$domain" "$menu_plist"
		exit 0 ;;
	--disable-app-login)
		[ "$#" -eq 1 ] || { echo "usage: install.sh --disable-app-login" >&2; exit 2; }
		launchctl disable "$domain/$menu_label"
		launchctl bootout "$domain/$menu_label" 2>/dev/null || true
		exit 0 ;;
	--app-only)
		[ "$#" -eq 1 ] || { echo "usage: install.sh --app-only" >&2; exit 2; }
		build_app
		render_menu
		[ "${FACTORY_LAUNCHD_RENDER_ONLY:-}" = 1 ] && exit 0
		launchctl enable "$domain/$menu_label"
		launchctl bootout "$domain/$menu_label" 2>/dev/null || true
		launchctl bootstrap "$domain" "$menu_plist"
		exit 0 ;;
	"") ;;
	*) echo "usage: install.sh [--app-only|--install-runner|--uninstall-runner|--start-runner|--stop-runner|--uninstall]" >&2; exit 2 ;;
esac

build_app
render_runner
render_menu
[ "${FACTORY_LAUNCHD_RENDER_ONLY:-}" = 1 ] && exit 0
launchctl enable "$domain/$label"
launchctl enable "$domain/$menu_label"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootout "$domain/$menu_label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
launchctl bootstrap "$domain" "$menu_plist"
