#!/usr/bin/env python3
"""Self-check for adopt.py: python3 skills/do-factory-setup/adopt.test.py
Uses a temporary git repo with a fake origin remote."""

import atexit
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

script = Path(__file__).resolve().parent / "adopt.py"
tmp = tempfile.mkdtemp()
atexit.register(shutil.rmtree, tmp)
repo = Path(tmp) / "repo"
repo.mkdir()
subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
subprocess.run(["git", "remote", "add", "origin", "git@github.com:acme/my-app.git"], cwd=repo, check=True)
(repo / ".env.production").write_text("ACME_MARKER=1\n")


def adopt(mode, block):
    r = subprocess.run([sys.executable, str(script), mode], input=block,
                       capture_output=True, text=True, cwd=repo)
    return r.returncode, r.stdout + r.stderr


_, out = adopt("check", '[applies]\nglob = ".env.*"\ncontains = "OTHER_MARKER"\n')
assert out == "applies: no\n", out
_, out = adopt("check", '[applies]\nglob = "*.toml"\n')
assert out == "applies: no\n", out
_, out = adopt("check", '[applies]\nglob = ".env.*"\ncontains = "ACME_MARKER"\n')
assert out.startswith("applies: yes\n"), out
_, out = adopt("check", "")
assert out.startswith("applies: yes\n"), out
print("ok: applies and skip")

_, out = adopt("check", 'done = "true"\n')
assert out == "applies: yes\ndone: true\n", out
_, out = adopt("check", 'done = "false"\n[[step]]\nname = "Add"\nrun = "echo hi"\n')
assert out == "applies: yes\ndone: false\nrun: Add: echo hi\n", out
block = 'done = "touch inspected"\n[[step]]\nname = "Add"\nrun = "touch ran"\n'
code, out = adopt("check", block)
assert code == 0 and out == "applies: yes\ndone: touch inspected\nrun: Add: touch ran\n", out
assert not (repo / "inspected").exists(), "inspection must never execute the done command"
assert not (repo / "ran").exists(), "inspection must never execute steps"
code, out = adopt("run", block)
assert code == 0 and out == "done: yes\n" and (repo / "inspected").exists(), out
assert not (repo / "ran").exists(), "a successful done command should skip steps"
code, out = adopt("run", 'done = "true"\n[[step]]\nname = "Add"\nrun = "touch ran"\n')
assert code == 0 and out == "done: yes\n" and not (repo / "ran").exists(), out
print("ok: done and not done")

block = '''
[[step]]
name = "Write vars"
run = 'echo "$REPO $REPO_PREFIX" > vars; echo LEAKED_OUT; echo LEAKED_ERR >&2'
[[step]]
name = "Make a token"
maintainer = "touch maintainer-ran"
[[step]]
name = "Break"
run = "exit 3"
[[step]]
name = "After"
run = "touch after-ran"
'''
code, out = adopt("run", block)
assert code == 1, out
assert out == ("ok: Write vars\nfailed: Break (exit 3)\n"
               "maintainer: Make a token: touch maintainer-ran\n"), out
assert (repo / "vars").read_text() == "acme/my-app MY_APP\n"
assert not (repo / "after-ran").exists(), "a failure should stop the run"
assert not (repo / "maintainer-ran").exists(), "maintainer steps never run"
assert "LEAKED" not in out
print("ok: failure stops the run, maintainer steps listed, output hidden")

code, out = adopt("run", '[[step]]\nname = "Both"\nrun = "true"\nmaintainer = "x"\n')
assert code != 0 and "exactly one" in out, out
print("ok: bad step rejected")

# The shipped example, against a fake service whose project already exists.
bin_dir = Path(tmp) / "bin"
bin_dir.mkdir()
fake = bin_dir / "example-vault"
fake.write_text('#!/bin/sh\n[ "$2" = create ] && touch "$PWD/registered"\nexit 0\n')
fake.chmod(0o755)
(repo / ".env.dev").write_text("EXAMPLE_VAULT=1\n")
example = (script.parent / "adding-a-repo.example.toml").read_text()
env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}


def adopt_example(mode):
    r = subprocess.run([sys.executable, str(script), mode], input=example,
                       capture_output=True, text=True, cwd=repo, env=env)
    return r.returncode, r.stdout + r.stderr


_, out = adopt_example("check")
assert out == ('applies: yes\ndone: example-vault project show "$REPO_PREFIX"\n'
               'run: Register the repo: example-vault project create "$REPO_PREFIX" --repo "$REPO"\n'
               "maintainer: Create the CI token: Create an Example Vault token for the project and store it as the repo's EXAMPLE_VAULT_TOKEN CI secret\n"), out
code, out = adopt_example("run")
assert code == 0 and out == "done: yes\n", out
assert not (repo / "registered").exists(), "a done example should skip registration"
print("ok: shipped example's done check is top-level")

print("all adopt checks passed")
