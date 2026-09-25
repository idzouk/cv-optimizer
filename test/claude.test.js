'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContent } = require('../lib/claude');

/**
 * A cache hit requires the cachedPrefix block to be byte-identical (and in
 * the same position, with the same system/tools around it) across calls —
 * these tests guard the one piece of that contract that lives in code: the
 * shape buildContent produces.
 */
test('buildContent: returns a plain string when there is no cachedPrefix', () => {
  assert.equal(buildContent(undefined, 'bonjour'), 'bonjour');
  assert.equal(buildContent('', 'bonjour'), 'bonjour');
});

test('buildContent: splits into a cached block and a variable block', () => {
  const content = buildContent('CV MASTER...', 'Offre : ...');
  assert.deepEqual(content, [
    { type: 'text', text: 'CV MASTER...\n\n', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Offre : ...' },
  ]);
});

test('buildContent: the concatenated blocks never glue two words together', () => {
  // The API concatenates consecutive text blocks with no separator of its
  // own — this is the regression the trailing "\n\n" above guards against.
  const [first, second] = buildContent('...se termine ici', 'Et ça commence là...');
  const concatenated = first.text + second.text;
  assert.match(concatenated, /ici\s+Et ça/);
});
