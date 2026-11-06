# Factory Verifier

Verifier selects and runs checks declared in `.factory/verifier.toml`. The core
requires Python 3.11+ and Git and uses only the Python standard library.

Edit `factory-verifier` and its tests here. The setup skill carries a generated
copy at `skills/do-factory-setup/verifier/factory-verifier` so an installed skill
can deliver the executable without a Factory checkout. Never edit that copy.

From the Factory root:

```sh
node packages/verifier/bundle.ts
node packages/verifier/bundle.ts --check
node --test packages/verifier/bundle.test.ts
python3 packages/verifier/factory-verifier.test.py
```

Regenerate and commit the bundle whenever the core changes. The consistency check
compares content and permissions; the Python suite tests delivery from an isolated
installed skill, including repeated copies and replacement of an old version.

The core currently supports `plan`, `run <check>` and `run --all`. Full setup
installation, hooks, hosted workflows and autopilot are still planned. The future
installer copies from the installed skill's `verifier/` directory to the consuming
repo's `scripts/factory-verifier`, preserving executable permissions. The committed
copy remains the version pin; setup updates produce reviewable diffs.
