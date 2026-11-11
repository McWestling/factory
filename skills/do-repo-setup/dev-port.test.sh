#!/bin/sh
# Self-check for dev-port: sh skills/do-repo-setup/dev-port.test.sh
# Uses a temporary XDG_STATE_HOME and temporary git repos. Assumes nothing
# else on this machine is listening on 55000-55020.
set -eu

script="$(cd "$(dirname "$0")" && pwd)/dev-port"
tmp=$(cd "$(mktemp -d)" && pwd -P)
listener=
cleanup() {
  # shellcheck disable=SC2086 # $listener is a list of pids
  if [ -n "$listener" ]; then kill $listener 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
export XDG_STATE_HOME="$tmp/state"
registry="$XDG_STATE_HOME/factory/dev-ports"

fail() { echo "FAIL: $*" >&2; exit 1; }
repo() { git init -q "$tmp/$1"; }
port_in() { (cd "$tmp/$1" && "$script"); }

repo a
repo b
[ "$(port_in a)" = 55000 ] || fail "first worktree should get 55000"
[ "$(port_in a)" = 55000 ] || fail "same worktree should get the same port"
[ "$(port_in b)" = 55010 ] || fail "second worktree should get 55010"
echo "ok: sticky, distinct, lowest first"

rm -rf "$tmp/a"
repo c
[ "$(port_in c)" = 55000 ] || fail "a removed worktree's block should be reused"
grep -q "^$tmp/a " "$registry" && fail "removed worktree should be pruned"
echo "ok: removed worktree's block reused"

rm -rf "$tmp/b" "$tmp/c"
nc -l 127.0.0.1 55000 >/dev/null 2>&1 &
listener=$!
nc -6 -l ::1 55010 >/dev/null 2>&1 &
listener="$listener $!"
sleep 1
repo d
[ "$(port_in d)" = 55020 ] || fail "listening base ports (IPv4 and IPv6) should be skipped"
echo "ok: listening port skipped"

rm -rf "$tmp/d"
: > "$registry"
i=0
while [ "$i" -lt 100 ]; do
  mkdir "$tmp/full $i"
  echo "$tmp/full $i $((55000 + i * 10))" >> "$registry"
  i=$((i + 1))
done
cp "$registry" "$tmp/before"
repo e
if port_in e 2>"$tmp/err"; then fail "a full range should exit non-zero"; fi
[ -s "$tmp/err" ] || fail "a full range should explain on stderr"
cmp -s "$registry" "$tmp/before" || fail "a full range should leave the registry alone"
[ -d "$registry.lock" ] && fail "the lock should be removed on failure"
echo "ok: full range fails cleanly"

echo "all dev-port checks passed"
