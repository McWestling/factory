import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSource } from './experiment-source.ts';

test('lowercases source while preserving whitespace', () => {
  assert.equal(normalizeSource(' McWestling/Factory\t'), ' mcwestling/factory\t');
});

test('keeps lowercase and empty source unchanged', () => {
  assert.equal(normalizeSource('already lowercase'), 'already lowercase');
  assert.equal(normalizeSource(''), '');
});
