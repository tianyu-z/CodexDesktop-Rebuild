const fs = require('node:fs');
const path = require('node:path');
const { replaceExactOnce } = require('./patch-agent-modes.js');

const HELPER = 'agent-modes-catalog.cjs';
const IMPORT = `var __cdxEngineCatalog=require("./${HELPER}").createInternalThreadFilter(process.env.CDX_ENGINE_STORE);\n`;
// Literal read seams from upstream 26.820.71523. Exclude before LIMIT/cursors,
// including pinned entries, while leaving catalog synchronization untouched.
const PATCHES = [
  ['catalog host lookup',
    'LIMIT 100`).all(e).sort((e,t)=>t.source_recency_at',
    'LIMIT 100`).all(e).filter(t=>__cdxEngineCatalog.visible(t.host_id,e)).sort((e,t)=>t.source_recency_at'],
  ['catalog entry',
    'readEntry(e){let t=this.db.prepare(`SELECT * FROM local_thread_catalog',
    'readEntry(e){if(!__cdxEngineCatalog.visible(this.hostId,e))return null;let t=this.db.prepare(`SELECT * FROM local_thread_catalog'],
  ['catalog entries',
    'readEntries(e){if(e.length>100)throw Error(`Thread catalog entry request exceeds 100`);if(e.length===0)return[];',
    'readEntries(e){if(e.length>100)throw Error(`Thread catalog entry request exceeds 100`);e=__cdxEngineCatalog.publicIds(this.hostId,e);if(e.length===0)return[];'],
  ['catalog page',
    'readPage({limit:e,cursor:t,filter:n,manualOrder:r,sortKey:i}){',
    'readPage({limit:e,cursor:t,filter:n,manualOrder:r,sortKey:i}){n=__cdxEngineCatalog.pageFilter(this.hostId,n);'],
];

function patchCatalogBundle(source) {
  for (const [name, before, after] of PATCHES) source = replaceExactOnce(source, before, after, name);
  const count = source.split(IMPORT).length - 1;
  if (count > 1) throw new Error('agent-modes: expected one catalog helper import');
  return count === 1 ? source : IMPORT + source;
}
function patchCatalogBuild(buildDir) {
  const files = fs.readdirSync(buildDir).filter(name => /^main-.*\.js$/.test(name));
  if (files.length !== 1) throw new Error(`agent-modes: expected one main bundle, found ${files.length}`);
  const file = path.join(buildDir, files[0]);
  const source = patchCatalogBundle(fs.readFileSync(file, 'utf8'));
  fs.copyFileSync(path.join(__dirname, 'assets', HELPER), path.join(buildDir, HELPER));
  fs.writeFileSync(file, source);
}
module.exports = { patchCatalogBundle, patchCatalogBuild };
