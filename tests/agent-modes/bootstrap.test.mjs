import test from 'node:test';
import assert from 'node:assert/strict';
import builder from '../../scripts/build-agent-modes-preview.js';
test('bootstrap selects separate app data before upstream starts and is idempotent',()=>{const base='const NAME="chatgpt-dev";require("./original.js")';const patched=builder.patchBootstrap(base);assert.ok(patched.indexOf('agent-modes-bootstrap.cjs')<patched.indexOf('original.js'));assert.match(patched,/CDX_ENGINE_APP_NAME/);assert.equal(builder.patchBootstrap(patched),patched);assert.throws(()=>builder.patchBootstrap('upstream changed'),/mismatch/);assert.throws(()=>builder.patchBootstrap(base+base),/mismatch/);});
