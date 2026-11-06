# Generated Verifier bundle

Edit `packages/verifier/factory-verifier` in Factory, then run
`node packages/verifier/bundle.ts` from its root and commit the result.
`node packages/verifier/bundle.ts --check` detects stale content or permissions.

This directory ships with the installed skill. Copy `factory-verifier` from here
to the consuming repo's `scripts/factory-verifier`, preserving its executable mode
and replacing differing copies. No sibling package or runtime download is needed.
