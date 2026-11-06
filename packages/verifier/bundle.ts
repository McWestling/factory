import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) {
  console.error('Usage: node packages/verifier/bundle.ts [--check]');
  process.exit(2);
}
const source = new URL('./factory-verifier', import.meta.url);
const bundle = new URL('../../skills/do-factory-setup/verifier/', import.meta.url);
const target = new URL('factory-verifier', bundle);
if (process.argv[2] === '--check') {
  if (!existsSync(target) || !readFileSync(source).equals(readFileSync(target))
      || (statSync(source).mode & 0o777) !== (statSync(target).mode & 0o777)) {
    console.error('Stale Verifier bundle: run node packages/verifier/bundle.ts');
    process.exit(1);
  }
} else {
  mkdirSync(bundle, { recursive: true });
  copyFileSync(source, target);
  chmodSync(target, statSync(source).mode & 0o777);
}
