const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
function packageRemoteRuntime(source, output) {
  const files = [];
  function walk(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const item = relative ? relative + '/' + name : name;
      if (name === '.bin' || /^node_modules\/@anthropic-ai\/claude-agent-sdk-/.test(item)) continue;
      const absolute = path.join(directory, name), stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, item);
      else if (stat.isFile()) files.push(item);
      else throw Error('Unsupported remote runtime entry: ' + item);
    }
  }
  walk(source);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-runtime-package-'));
  try {
    const list = path.join(temp, 'files'); fs.writeFileSync(list, files.join('\0') + '\0');
    execFileSync('/usr/bin/tar', ['--no-recursion', '--null', '-czf', output, '-C', source, '-T', list], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    return { sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'), files: files.length };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
module.exports = { packageRemoteRuntime };
