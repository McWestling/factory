#!/usr/bin/env python3
"""Run one Tool Stack page's "Adding a repo" block in the current repo.

  python3 adopt.py check < block.toml   # does it apply, is it done, what would run
  python3 adopt.py run   < block.toml   # run its steps, stop at the first failure

The block format is in adding-a-repo.example.toml. Commands run through the
shell from the repo root, with REPO (owner/name) and REPO_PREFIX (the name,
upper-cased, non-alphanumerics as _) added to the environment. Their stdout
and stderr are never shown: only step names, ok/failed and exit codes.
Needs Python 3.11+ (tomllib).
"""

import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def repo_env():
    url = git("remote", "get-url", "origin")
    m = re.search(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$", url)
    if not m:
        sys.exit(f"can't read owner/name from the origin remote: {url}")
    owner, name = m.groups()
    return {**os.environ, "REPO": f"{owner}/{name}",
            "REPO_PREFIX": re.sub(r"[^A-Z0-9]", "_", name.upper())}


def sh(cmd, env):
    return subprocess.run(cmd, shell=True, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def applies(block):
    rule = block.get("applies")
    if rule is None:
        return True
    if "glob" not in rule:
        sys.exit("[applies] needs a glob")
    files = [p for p in Path(".").glob(rule["glob"]) if p.is_file()]
    if "contains" not in rule:
        return bool(files)
    return any(rule["contains"] in p.read_text(errors="ignore") for p in files)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("check", "run"):
        sys.exit("usage: adopt.py check|run < block.toml")
    block = tomllib.loads(sys.stdin.read())
    steps = block.get("step", [])
    for s in steps:
        if "name" not in s or ("run" in s) == ("maintainer" in s):
            sys.exit(f"each [[step]] needs a name and exactly one of run or maintainer: {s}")
    os.chdir(git("rev-parse", "--show-toplevel"))
    env = repo_env()

    if not applies(block):
        print("applies: no")
        return
    done = "done" in block and sh(block["done"], env) == 0
    if sys.argv[1] == "check":
        print("applies: yes")
        print(f"done: {'yes' if done else 'no'}")
        if not done:
            for s in steps:
                print(f"run: {s['name']}: {s['run']}" if "run" in s
                      else f"maintainer: {s['name']}: {s['maintainer']}")
        return
    if done:
        print("done: yes")
        return
    failed = False
    for s in steps:
        if "run" not in s:
            continue
        code = sh(s["run"], env)
        if code:
            print(f"failed: {s['name']} (exit {code})")
            failed = True
            break
        print(f"ok: {s['name']}")
    for s in steps:
        if "maintainer" in s:
            print(f"maintainer: {s['name']}: {s['maintainer']}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
