'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const args of [['tools/check_frontend_build.mjs'], ['--test', 'frontend/tests/tab-controller.test.mjs',
  'frontend/tests/route-geometry.test.mjs', 'frontend/tests/workspace-service.test.mjs', 'frontend/tests/step-navigation.test.mjs', 'frontend/tests/membership-refresh.test.mjs', 'frontend/tests/bench-arrangement.test.mjs']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stdout + result.stderr); process.exit(result.status || 1); }
}
console.log('UI architecture ok (build provenance and serialized workspace commands)');
