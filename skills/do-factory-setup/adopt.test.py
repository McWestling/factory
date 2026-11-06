#!/usr/bin/env python3
"""Self-check for adopt.py: python3 skills/do-factory-setup/adopt.test.py
Uses a temporary git repo with a fake origin remote."""

import atexit
import os
import re
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
assert out == "applies: yes\ndone-check: true\n", out
_, out = adopt("check", 'done = "false"\n[[step]]\nname = "Add"\nrun = "echo hi"\n')
assert out == "applies: yes\ndone-check: false\nrun: Add: echo hi\n", out
block = 'done = "touch inspected"\n[[step]]\nname = "Add"\nrun = "touch ran"\n'
code, out = adopt("check", block)
assert code == 0 and out == "applies: yes\ndone-check: touch inspected\nrun: Add: touch ran\n", out
assert not (repo / "inspected").exists(), "inspection must never execute the done command"
assert not (repo / "ran").exists(), "inspection must never execute steps"
code, out = adopt("run", block)
assert code == 0 and out == "done: yes\n" and (repo / "inspected").exists(), out
assert not (repo / "ran").exists(), "a successful done command should skip steps"
code, out = adopt("run", 'done = "true"\n[[step]]\nname = "Add"\nrun = "touch ran"\n')
assert code == 0 and out == "done: yes\n" and not (repo / "ran").exists(), out
code, out = adopt("run", 'done = "touch done-ran; false"\n[[step]]\nname = "Add"\nrun = "touch ran"\n')
assert code == 0 and out == "ok: Add\n", out
assert (repo / "done-ran").exists() and (repo / "ran").exists()
print("ok: run does the done check, then skips or runs the steps")

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
assert out == ('applies: yes\ndone-check: example-vault project show "$REPO_PREFIX"\n'
               'run: Register the repo: example-vault project create "$REPO_PREFIX" --repo "$REPO"\n'
               "maintainer: Create the CI token: Create an Example Vault token for the project "
               "and store it as the repo's EXAMPLE_VAULT_TOKEN CI secret\n"), out
code, out = adopt_example("run")
assert code == 0 and out == "done: yes\n", out
assert not (repo / "registered").exists(), "a done example should skip registration"
print("ok: shipped example's done check is top-level")

# The interpreter search in SKILL.md, run as written against fake PATHs.
find_python = re.search(r"```sh\n\s*(sh -c 'IFS=:.*?)\n\s*```",
                        (script.parent / "SKILL.md").read_text(), re.S).group(1)
tools = Path(tmp) / "tools"
tools.mkdir()
(tools / "sh").symlink_to("/bin/sh")  # all the search may use from PATH: sh, to start itself


def fake_python(path, version, code=0):
    path.parent.mkdir(exist_ok=True)
    path.write_text(f'#!/bin/sh\necho "Python {version}"\nexit {code}\n')
    path.chmod(0o755)
    return path


def search(*dirs, cwd=tmp):
    path = ":".join(str(d) for d in (tools, *dirs))
    return subprocess.run(["/bin/sh", "-c", find_python], capture_output=True, text=True,
                          cwd=cwd, env={"PATH": path})


old, new, too_old, broken = (Path(tmp) / d for d in ("old", "new", "too-old", "broken"))
fake_python(old / "python3", "3.9.6")
newest = fake_python(new / "python3", "3.15.0")
r = search(old, new)
assert r.returncode == 0 and r.stdout == f"{newest}\n", r
print("ok: an older python3 first doesn't hide a newer one later on PATH")

versioned = fake_python(Path(tmp) / "versioned" / "python3.11", "3.11.4")
r = search(old, versioned.parent)
assert r.returncode == 0 and r.stdout == f"{versioned}\n", r
print("ok: a versioned command qualifies, down to 3.11")

fake_python(too_old / "python3.10", "3.10.14")
fake_python(broken / "python3", "3.15.0", code=1)
r = search(old, too_old, broken)
assert r.returncode == 1 and r.stdout == "", r
path_with_relative = f"{tools}::."  # empty and "." both mean the current directory
r = subprocess.run(["/bin/sh", "-c", find_python], capture_output=True, text=True,
                   cwd=new, env={"PATH": path_with_relative})
assert r.returncode == 1 and r.stdout == "", r
print("ok: nothing qualifies when versions are too old, broken or only on relative entries")

print("all adopt checks passed")
