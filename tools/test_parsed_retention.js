'use strict';

// Run: node tools/test_parsed_retention.js
// Guards the entry-construction rule in app.js: a lazy entry whose body is already
// in memory must keep its parsed structure, otherwise only that entry falls back to
// raw coordinates and skips alignment (the first card of a folder is typically the
// pre-loaded cover). Extracts the real source expression, not a copy.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

const line = source.match(/^ {8}_parsed: .*$/m);
assert(line, 'Missing _parsed initializer in app.js');
const expression = line[0].replace(/^\s*_parsed:\s*/, '').replace(/,\s*$/, '');

// Evaluate the shipped expression with fixtures mirroring real raw objects.
const derive = new Function('raw', 'return (' + expression + ');');

// 1. Pre-loaded lazy copy: body present and parsed known -> keep parsed.
assert.deepEqual(derive({ lazy: true, data: 'ATOM ...', parsed: { atoms: [1] } }), { atoms: [1] },
  'a lazy entry that already holds its body must keep its parsed structure');

// 2. Not-yet-fetched lazy entry keeps the getter lazy instead of parsing empty text.
assert.equal(derive({ lazy: true, data: '' }), null, 'an unloaded lazy entry stays unparsed');
assert.equal(derive({ lazy: true }), null, 'an unloaded lazy entry with no data stays unparsed');

// 3. Non-lazy entries keep whichever parse state they were given.
assert.deepEqual(derive({ data: 'ATOM', parsed: { atoms: [2] } }), { atoms: [2] });
assert.equal(derive({ data: 'ATOM' }), undefined, 'undefined lets the getter parse on demand');
assert.equal(derive({ data: 'ATOM', parsed: null }), null, 'a known parse failure stays failed');

// 4. URL entries never hold local text to parse.
assert.equal(derive({ isUrl: true, parsed: { atoms: [3] } }), null);

// 5. The getter must still short-circuit on a defined value, so upstream nulls persist.
const getter = source.match(/get:\s*function \(\) \{\s*\n\s*if \(this\._parsed !== undefined\) return this\._parsed;/);
assert(getter, '_parsed getter must keep its defined-value short circuit');

console.log('parsed retention ok (pre-loaded lazy copies keep parsed data; unloaded/url entries stay lazy)');
