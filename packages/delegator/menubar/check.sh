#!/bin/sh
set -eu

dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
swiftc -typecheck "$dir/Status.swift" "$dir/App.swift"
swiftc -parse-as-library "$dir/Status.swift" "$dir/Status.test.swift" -o "$tmp/status-check"
"$tmp/status-check"
