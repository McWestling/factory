"""Run with: python3 packages/verifier/factory-verifier.test.py"""

import fcntl
import json
import select
import signal
import time
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).resolve().with_name("factory-verifier")


class FactoryVerifierTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="factory-verifier-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "repo with spaces"
        self.root.mkdir()
        self.env = os.environ.copy()
        self.env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + self.env.get("PATH", "")
        self.env.pop("FACTORY_VERIFIER_OVERRIDE", None)
        self.env["XDG_STATE_HOME"] = str(Path(directory.name) / "state")
        self.env.update(
            GIT_CONFIG_NOSYSTEM="1",
            GIT_CONFIG_GLOBAL=os.devnull,
            GIT_AUTHOR_NAME="Test",
            GIT_AUTHOR_EMAIL="test@example.invalid",
            GIT_COMMITTER_NAME="Test",
            GIT_COMMITTER_EMAIL="test@example.invalid",
        )
        self.git("init", "-q")
        self.contract = self.root / ".factory/verifier.toml"
        self.contract.parent.mkdir()
        self.write_contract("version = 1\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD")

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], cwd=self.root, env=self.env, text=True,
            stderr=subprocess.PIPE,
        ).strip()

    def write_contract(self, text):
        self.contract.write_text(textwrap.dedent(text), encoding="utf-8")

    def verifier(self, *args, cwd=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=cwd or self.root, env=self.env, text=True, capture_output=True,
        )

    def assert_fails_cleanly(self, result, *messages):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)
        for message in messages:
            self.assertIn(message, result.stderr)

    def commit_change(self, path, content="changed\n"):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.git("add", "--", path)
        self.git("commit", "-qm", "change")
        return self.git("rev-parse", "HEAD")

    def start_verifier(self, *args, cwd=None):
        process = subprocess.Popen(
            [sys.executable, str(SCRIPT), *args], cwd=cwd or self.root,
            env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        def cleanup():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
        self.addCleanup(cleanup)
        return process

    def wait_line(self, process):
        self.assertTrue(select.select([process.stdout], [], [], 5)[0], "no WAIT output")
        return process.stdout.readline().strip()

    def test_run_waits_and_non_running_commands_and_skips_do_not(self):
        self.save_contract()
        self.assertEqual(self.verifier("preflight").returncode, 0)
        lock_path = Path(self.env["XDG_STATE_HOME"]) / "factory/verifier.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("w+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            json.dump({"check": "holder", "worktree": "/other repo", "pid": 123}, lock)
            lock.flush()
            for args in [("plan", "--all"), ("pre-push",), ("preflight",)]:
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), *args], cwd=self.root, env=self.env,
                    text=True, capture_output=True, input="", timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("WAIT", result.stdout)
            process = self.start_verifier("run", "first")
            self.assertEqual(self.wait_line(process),
                             "WAIT first: holder running in /other repo (pid 123)")
            self.assertIsNone(process.poll())
            fcntl.flock(lock, fcntl.LOCK_UN)
            output, errors = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, errors)
            self.assertNotIn("WAIT", output)

    def test_linked_preflights_never_overlap(self):
        import shlex
        events = self.root.parent / "events"
        release = self.root.parent / "release"
        code = (
            "import os,pathlib,time; "
            f"events=pathlib.Path({str(events)!r}); release=pathlib.Path({str(release)!r}); "
            "f=events.open('a'); f.write(f'start {time.monotonic_ns()}\\n'); f.flush(); "
            "deadline=time.monotonic()+10; "
            "exec('while not release.exists() and time.monotonic()<deadline: time.sleep(0.01)'); "
            "assert release.exists(); f.write(f'end {time.monotonic_ns()}\\n'); f.close()"
        )
        self.save_contract(shlex.join([sys.executable, "-c", code]))
        other = self.root.parent / "linked"
        self.git("worktree", "add", "-qb", "linked", str(other))
        first = self.start_verifier("preflight")
        deadline = time.monotonic() + 5
        while (not events.exists() or not events.read_text()) and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(events.exists())
        second = self.start_verifier("preflight", cwd=other)
        self.assertEqual(self.wait_line(second),
                         f"WAIT first: first running in {self.root.resolve()} (pid {first.pid})")
        release.touch()
        for process in (first, second):
            output, errors = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, errors)
            self.assertIn("PASS first", output)
        lines = events.read_text().splitlines()
        self.assertEqual([line.split()[0] for line in lines], ["start", "end", "start", "end"])
        self.assertLessEqual(int(lines[1].split()[1]), int(lines[2].split()[1]))

    def test_check_keeps_lock_after_verifier_is_killed(self):
        import shlex
        release = self.root.parent / "release"
        code = (
            "import pathlib,time; "
            f"release=pathlib.Path({str(release)!r}); "
            "print('started', flush=True); deadline=time.monotonic()+10; "
            "exec('while not release.exists() and time.monotonic()<deadline: time.sleep(0.01)'); "
            "assert release.exists(); print('finished', flush=True)"
        )
        # Keep the shell alive too, rather than letting it replace itself with Python.
        self.save_contract(shlex.join([sys.executable, "-c", code]) + "; :")
        first = self.start_verifier("run", "first")
        self.assertEqual(self.wait_line(first), "started")
        first.kill()
        first.wait(timeout=5)
        second = self.start_verifier("run", "first")
        self.assertEqual(self.wait_line(second),
                         f"WAIT first: first running in {self.root.resolve()} (pid {first.pid})")
        self.assertIsNone(second.poll())
        release.touch()
        output, errors = first.communicate(timeout=5)
        self.assertIn("finished", output)
        output, errors = second.communicate(timeout=5)
        self.assertEqual(second.returncode, 0, errors)
        self.assertEqual(output.splitlines(), ["started", "finished"])

    def test_killed_holder_releases_lock_and_unreadable_details_still_wait(self):
        self.save_contract()
        lock_path = Path(self.env["XDG_STATE_HOME"]) / "factory/verifier.lock"
        lock_path.parent.mkdir(parents=True)
        holder = subprocess.Popen(
            [sys.executable, "-c",
             "import fcntl,sys,time; f=open(sys.argv[1], 'w'); "
             "fcntl.flock(f, fcntl.LOCK_EX); print('ready', flush=True); time.sleep(30)",
             str(lock_path)], stdout=subprocess.PIPE, text=True,
        )
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        self.assertEqual(holder.stdout.readline(), "ready\n")
        waiter = self.start_verifier("run", "--all")
        self.assertEqual(self.wait_line(waiter), "WAIT first")
        holder.kill()
        holder.wait(timeout=5)
        holder.stdout.close()
        output, errors = waiter.communicate(timeout=5)
        self.assertEqual(waiter.returncode, 1, errors)  # hosted check deliberately fails
        self.assertIn("PASS first", output)
        self.assertTrue(lock_path.exists())

    def test_isolated_skill_delivery_and_repeatable_update(self):
        installed = self.root.parent / "installed-skill"
        shutil.copytree(SCRIPT.parents[2] / "skills/do-factory-setup", installed)
        self.assertFalse((installed.parent / "packages").exists())
        bundled = installed / "verifier/factory-verifier"
        delivered = self.root / "scripts/factory-verifier"
        delivered.parent.mkdir()
        self.write_contract('''version = 1
[checks.smoke]
run = "printf delivered"
paths = ["**"]
''')
        for _ in range(2):
            shutil.copy2(bundled, delivered)
            self.assertTrue(os.access(delivered, os.X_OK))
            result = subprocess.run([str(delivered), "run", "smoke"], cwd=self.root,
                                    env=self.env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "delivered")
            self.assertEqual(delivered.read_bytes(), SCRIPT.read_bytes())
        delivered.write_text("stale")
        shutil.copy2(bundled, delivered)
        self.assertEqual(delivered.read_bytes(), SCRIPT.read_bytes())

    def test_local_field_keeps_hosted_plan_and_run(self):
        self.write_contract('version = 1\n[checks.hosted]\nrun = "printf hosted"\npaths = ["**"]\nlocal = false\n')
        self.assertEqual(json.loads(self.verifier("plan", "--all").stdout)["checks"], ["hosted"])
        self.assertEqual(self.verifier("run", "hosted").stdout, "hosted")
        for value in ['"false"', '0', '[]']:
            self.write_contract('version = 1\n[checks.bad]\nrun = "true"\npaths = ["**"]\nlocal = ' + value)
            self.assert_fails_cleanly(self.verifier("plan", "--all"), "local")

    def save_contract(self, command="true"):
        self.write_contract('version = 1\n[checks.first]\nrun = ' + json.dumps(command) + '\npaths = ["src/**"]\n[checks.hosted]\nrun = "exit 9"\npaths = ["**"]\nlocal = false\n')
        self.git("add", ".")
        self.git("commit", "-qm", "contract")

    def state(self):
        return self.root / ".git/factory-verifier"

    def test_preflight_saves_and_reuses_full_local_evidence(self):
        self.save_contract()
        result = self.verifier()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS first", result.stdout)
        self.assertIn("SKIP hosted (hosted only)", result.stdout)
        tree = self.git("rev-parse", "HEAD^{tree}")
        self.assertEqual(json.loads((self.state() / (tree + ".json")).read_text())["passed"], ["first"])
        self.assertIn("SKIP first", self.verifier("preflight").stdout)
        self.git("commit", "--amend", "-qm", "new message")
        self.assertIn("SKIP first", self.verifier("preflight").stdout)
        self.commit_change("outside.txt")
        self.assertIn("PASS first", self.verifier("preflight").stdout)

    def test_real_push_requires_evidence_and_reads_each_committed_contract(self):
        delivered = self.root / "scripts/factory-verifier"
        delivered.parent.mkdir()
        shutil.copy2(SCRIPT, delivered)
        self.save_contract()
        remote = self.root.parent / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True, env=self.env)
        self.git("remote", "add", "origin", str(remote))
        self.assertEqual(self.verifier("install-hook").returncode, 0)

        def push(*refs):
            return subprocess.run(["git", "push", "origin", *refs], cwd=self.root,
                                  env=self.env, text=True, capture_output=True)

        blocked = push("HEAD:refs/heads/main")
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("first", blocked.stderr)
        self.assertIn("scripts/factory-verifier preflight", blocked.stderr)
        self.assertEqual(self.verifier("preflight").returncode, 0)
        self.git("commit", "--amend", "-qm", "message only")
        self.assertEqual(push("HEAD:refs/heads/main").returncode, 0)
        old = self.git("rev-parse", "HEAD")
        self.commit_change("uncovered.txt")
        self.assertNotEqual(push("HEAD:refs/heads/main").returncode, 0)
        self.assertEqual(push(old + ":refs/tags/proof").returncode, 0)
        self.assertEqual(push(":refs/heads/main").returncode, 0)
        missing = self.git("rev-parse", "HEAD")
        self.write_contract('version = 1\n[checks.hosted]\nrun = "false"\npaths = ["**"]\nlocal = false\n')
        self.git("add", ".")
        self.git("commit", "-qm", "hosted only")
        self.assertEqual(push("HEAD:refs/heads/hosted").returncode, 0)
        self.assertNotEqual(push("HEAD:refs/heads/other", missing + ":refs/heads/missing").returncode, 0)
        self.write_contract("version = 1\n")
        self.git("add", ".")
        self.git("commit", "-qm", "no checks")
        self.assertEqual(push("HEAD:refs/heads/empty").returncode, 0)
        self.env["FACTORY_VERIFIER_OVERRIDE"] = "  "
        self.assertNotEqual(push(missing + ":refs/heads/missing").returncode, 0)
        self.env["FACTORY_VERIFIER_OVERRIDE"] = "approved test reason"
        result = push(missing + ":refs/heads/missing")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("UNVERIFIED PUSH: approved test reason", result.stderr)
        entry = json.loads((self.state() / "overrides.jsonl").read_text())
        self.assertEqual(entry["reason"], "approved test reason")
        self.assertIn("refs/heads/missing", str(entry["refs"]))

    def test_dirty_runs_and_checks_that_dirty_or_change_head_save_no_evidence(self):
        for command in ["true", "touch created", "git commit --allow-empty -qm changed"]:
            with self.subTest(command=command):
                self.git("reset", "--hard", self.base)
                self.git("clean", "-fd")
                self.save_contract(command)
                if command == "true":
                    (self.root / "untracked").touch()
                tree = self.git("rev-parse", "HEAD^{tree}")
                result = self.verifier("preflight")
                self.assertIn("PASS first", result.stdout)
                self.assertIn("No evidence saved", result.stdout)
                self.assertFalse((self.state() / (tree + ".json")).exists())

    def test_failure_reports_tail_before_later_checks_and_saves_partial_evidence(self):
        self.write_contract('''version = 1
[checks.fail]
run = "seq 1 25; exit 7"
paths = ["**"]
[checks.later]
run = "true"
paths = ["**"]
''')
        self.git("add", ".")
        self.git("commit", "-qm", "checks")
        result = self.verifier("preflight")
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(result.stdout.index("FAIL fail"), result.stdout.index("PASS later"))
        self.assertIn("6\n7\n", result.stdout)
        self.assertNotIn("\n5\n", result.stdout)
        self.assertIn("fail.log", result.stdout)
        tree = self.git("rev-parse", "HEAD^{tree}")
        self.assertEqual(json.loads((self.state() / (tree + ".json")).read_text())["passed"], ["later"])

    def test_failure_is_visible_while_next_check_waits(self):
        signal = self.root.parent / "continue"
        wait = ("import pathlib,time; p=pathlib.Path(" + repr(str(signal)) + "); "
                "deadline=time.monotonic()+5; "
                "exec('while not p.exists() and time.monotonic()<deadline: time.sleep(0.01)'); "
                "assert p.exists()")
        import shlex
        self.write_contract('version = 1\n[checks.fail]\nrun = "echo failure-tail; exit 1"\npaths = ["**"]\n'
                            '[checks.wait]\nrun = ' + json.dumps(shlex.join([sys.executable, "-c", wait])) + '\npaths = ["**"]\n')
        self.git("add", ".")
        self.git("commit", "-qm", "checks")
        process = subprocess.Popen([sys.executable, str(SCRIPT), "preflight"], cwd=self.root,
                                   env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(process.stdout.readline(), "FAIL fail\n")
            self.assertIn("fail.log", process.stdout.readline())
            self.assertEqual(process.stdout.readline(), "failure-tail\n")
            signal.touch()
            output, errors = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 1, errors)
            self.assertIn("PASS wait", output)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_install_hook_shared_idempotent_and_preserves_foreign_hook(self):
        self.save_contract()
        self.assertEqual(self.verifier("preflight").returncode, 0)
        self.assertEqual(self.verifier("install-hook").returncode, 0)
        hook = self.root / ".git/hooks/pre-push"
        content = hook.read_bytes()
        other = self.root.parent / "linked"
        self.git("worktree", "add", "-qb", "linked", str(other))
        self.assertEqual(self.verifier("install-hook", cwd=other).returncode, 0)
        self.assertEqual(hook.read_bytes(), content)
        self.assertIn("SKIP first", self.verifier("preflight", cwd=other).stdout)
        hook.write_text("#!/bin/sh\nexit 42\n")
        result = self.verifier("install-hook", cwd=other)
        self.assertEqual(result.returncode, 0)
        self.assertIn("WARNING", result.stderr)
        self.assertEqual(hook.read_text(), "#!/bin/sh\nexit 42\n")

    def test_usage_errors_exit_2(self):
        for args in [("unknown",), ("plan",), ("plan", "--base", "HEAD"), ("plan", "--head", "HEAD"),
                     ("plan", "--all", "--base", "HEAD"),
                     ("plan", "--all", "--head", "HEAD"), ("run",), ("run", "--all", "extra")]:
            with self.subTest(args=args):
                result = self.verifier(*args, cwd=self.root.parent)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("usage:", result.stderr.lower())

    def test_run_uses_repo_root_and_preserves_exit_status(self):
        self.write_contract('''\
            version = 1
            [checks.tests]
            run = "test -d .factory && printf '%s' framework-output; exit 7"
            paths = ["**"]
        ''')
        nested = self.root / "apps/ios"
        nested.mkdir(parents=True)
        result = self.verifier("run", "tests", cwd=nested)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(result.stdout, "framework-output")

    def test_run_all_continues_and_reports_in_file_order(self):
        self.write_contract(r'''
            version = 1
            [checks.first]
            run = "printf 'first\\n'; exit 7"
            paths = ["**"]
            [checks.last]
            run = "printf 'last\\n'"
            paths = ["**"]
        ''')
        result = self.verifier("run", "--all")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "first\nFAIL first\nlast\nPASS last\n")

    def test_plan_all_lists_checks_in_file_order_without_running_them(self):
        self.write_contract('''version = 1
[checks.z-last-alphabetically]
run = "exit 7"
paths = ["unmodified/**"]
[checks.a-first-alphabetically]
run = "exit 8"
paths = ["also-unmodified/**"]
''')
        result = self.verifier("plan", "--all")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "checks": ["z-last-alphabetically", "a-first-alphabetically"],
        })

    def test_plan_selects_cross_app_and_everything_in_file_order(self):
        self.write_contract('''\
            version = 1
            [checks.ios-contract]
            run = "exit 0"
            paths = ["packages/api-schema/**", "apps/ios/**"]
            [checks.everything]
            run = "exit 0"
            paths = ["**"]
            [checks.docs]
            run = "exit 0"
            paths = ["docs/**"]
        ''')
        head = self.commit_change("packages/api-schema/schema.txt")
        nested = self.root / "apps/ios"
        nested.mkdir(parents=True)
        result = self.verifier("plan", "--base", self.base, "--head", head, cwd=nested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "base": self.base, "head": head,
            "checks": ["ios-contract", "everything"],
        })

    def test_plan_covers_root_files_and_ignores_unchanged_trees(self):
        self.write_contract('''\
            version = 1
            [checks.everything]
            run = "exit 0"
            paths = ["**"]
        ''')
        head = self.commit_change("root.txt")
        for base, expected in [(self.base, ["everything"]), (head, [])]:
            with self.subTest(base=base):
                result = self.verifier("plan", "--base", base, "--head", head)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["checks"], expected)

    def test_uncovered_changes_and_base_only_changes_select_nothing(self):
        self.write_contract('''\
            version = 1
            [checks.ios]
            run = "exit 0"
            paths = ["apps/ios/**"]
        ''')
        head = self.commit_change("packages/schema.txt")
        self.git("checkout", "-qb", "other", self.base)
        diverged = self.commit_change("apps/ios/base-only.txt")
        for base in (self.base, diverged):
            with self.subTest(base=base):
                result = self.verifier("plan", "--base", base, "--head", head)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["checks"], [])

    def test_zero_checks(self):
        result = self.verifier("plan", "--all")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"checks": []})
        result = self.verifier("run", "--all")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        result = self.verifier("plan", "--base", self.base, "--head", self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["checks"], [])

    def test_unknown_check_and_bad_revisions_fail_without_tracebacks(self):
        for args, message in [
            (("run", "missing"), "unknown check: missing"),
            (("plan", "--base", "deadbeef", "--head", self.base), "revision"),
        ]:
            with self.subTest(args=args):
                self.assert_fails_cleanly(self.verifier(*args), message)

    def test_invalid_contracts_fail_before_any_check_runs(self):
        valid = 'version = 1\n[checks.good]\nrun = "printf must-not-run"\npaths = ["**"]\n'
        cases = [
            ("", "version"),
            ("version = 2", "version"),
            ("version = true", "version"),
            ("version = 1.0", "version"),
            ('version = 1\nextra = "unknown"', "extra"),
            ("version = 1\nchecks = []", "checks"),
            ("version = 1\n[checks.Bad_Name]", "Bad_Name"),
            ("version = 1\n[checks.missing]", "run"),
            ('version = 1\n[checks.missing]\nrun = "exit 0"', "paths"),
            ('version = 1\n[checks.wrong]\nrun = 42\npaths = ["**"]', "run"),
            ('version = 1\n[checks.wrong]\nrun = "\\u0000"\npaths = ["**"]', "run"),
            ('version = 1\n[checks.wrong]\nrun = ""\npaths = "**"', "paths"),
            ('version = 1\n[checks.wrong]\nrun = ""\npaths = []', "paths"),
            ('version = 1\n[checks.wrong]\nrun = ""\npaths = [42]', "paths"),
            ('version = 1\n[checks.wrong]\nrun = ""\npaths = [""]', "paths"),
            ('version = 1\n[checks.wrong]\nrun = ""\npaths = ["\\u0000"]', "paths"),
            ("version = 1\n[checks]\nwrong = 42", "wrong"),
            (valid + "timeout = 5", "timeout"),
            (valid + '[checks.later]\nrun = "exit 0"', "paths"),
        ]
        for text, message in cases:
            with self.subTest(contract=text):
                self.write_contract(text)
                self.assert_fails_cleanly(self.verifier("run", "--all"), ".factory/verifier.toml", message)

    def test_toml_syntax_errors_name_file_and_line(self):
        for text, location in [
            ('version = 1\n[checks.bad]\nrun = "unterminated', "end of document"),
            ('version = 1\n[checks.bad]\nrun = "\\q"', "line 3"),
            ('version = 1\n[checks.bad]\n[checks.bad]', "line 3"),
        ]:
            with self.subTest(contract=text):
                self.write_contract(text)
                self.assert_fails_cleanly(self.verifier("run", "--all"), ".factory/verifier.toml", location)

    def test_standard_toml_and_literal_path_arguments(self):
        self.write_contract(r"""
            # A repo can use standard TOML syntax.
            version = 1
            [checks.ios-contract] # A comment after a table.
            run = '''
            printf '%s\n' "it's # literal"
            printf '%s' framework
            '''
            paths = [
                "apps/\u0069os/**",
                "odd dir/it's # $(touch injected) [x].txt",
            ]
        """)
        result = self.verifier("run", "ios-contract")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "it's # literal\nframework")
        base = self.base
        for path in ("apps/ios/file.txt", "odd dir/it's # $(touch injected) x.txt"):
            with self.subTest(path=path):
                head = self.commit_change(path)
                result = self.verifier("plan", "--base", base, "--head", head)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["checks"], ["ios-contract"])
                self.assertFalse((self.root / "injected").exists())
                base = head

    def test_signal_exit_status_and_all_pass(self):
        self.write_contract('''\
            version = 1
            [checks.signal]
            run = 'kill -TERM $$'
            paths = ["**"]
        ''')
        result = self.verifier("run", "signal")
        self.assertEqual(result.returncode, 143, result.stderr)
        self.write_contract('''\
            version = 1
            [checks.pass]
            run = 'exit 0'
            paths = ["**"]
        ''')
        result = self.verifier("run", "--all")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "PASS pass\n")

    def test_missing_file_and_invalid_encoding(self):
        self.contract.unlink()
        self.assert_fails_cleanly(self.verifier("run", "--all"), ".factory/verifier.toml")
        self.contract.write_bytes(b"version = 1\n# \xff")
        self.assert_fails_cleanly(self.verifier("run", "--all"), ".factory/verifier.toml")


if __name__ == "__main__":
    unittest.main()
