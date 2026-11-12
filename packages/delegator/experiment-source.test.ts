import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSource } from './experiment-source.ts';

test('lowercases mixed ASCII case', () => {
  assert.equal(normalizeSource('McWestling/Factory'), 'mcwestling/factory');
});

test('leaves lowercase input unchanged', () => {
  assert.equal(normalizeSource('mcwestling/factory'), 'mcwestling/factory');
});

test('keeps empty input empty', () => {
  assert.equal(normalizeSource(''), '');
});

test('preserves surrounding whitespace', () => {
  assert.equal(normalizeSource(' McWestling/Factory\t'), ' mcwestling/factory\t');
});
