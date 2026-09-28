// Opt-in acceptance helper: use the exact pinned App SSH login-shell wrapper.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

export function nativeLoginWrapper(bundlePath = process.env.CDX_LIVE_NATIVE_BUNDLE ?? resolve('src/mac-arm64/_asar/.vite/build/main-3kQRhaYi.js')) {
  const source = readFileSync(bundlePath, 'utf8');
  const extract = (start, end) => {
    if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error('Pinned native SSH login wrapper seam changed.');
    const first = source.indexOf(start), last = source.indexOf(end, first);
    if (last < first) throw new Error('Pinned native SSH login wrapper order changed.');
    return source.slice(first, last);
  };
  const declarations = extract('var Zse=`codex`,Qse=', 'function ece(){');
  const bytes = extract('function ice(e){', 'var SS=`ssh_websocket_v0`');
  return runInNewContext(`${declarations}\n${bytes}\nbS`, Object.create(null), { timeout: 1000 });
}
