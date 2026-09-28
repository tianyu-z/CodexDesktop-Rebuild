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
    const program = `import gzip,tarfile,os,sys
source,output,listing=sys.argv[1:]
files=open(listing,"rb").read().split(b"\\0")
with open(output,"wb") as raw:
 with gzip.GzipFile(filename="",mode="wb",fileobj=raw,mtime=0,compresslevel=6) as compressed:
  with tarfile.open(mode="w|",fileobj=compressed,format=tarfile.PAX_FORMAT) as archive:
   for entry in files:
    if not entry: continue
    name=entry.decode("utf-8")
    absolute=os.path.join(source,name)
    info=archive.gettarinfo(absolute,arcname=name)
    info.uid=info.gid=0
    info.uname=info.gname=""
    info.mtime=0
    info.pax_headers={}
    info.mode=0o755 if info.mode & 0o111 else 0o644
    with open(absolute,"rb") as data: archive.addfile(info,data)
`;
    execFileSync('python3', ['-c', program, source, output, list]);
    return { sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'), files: files.length };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
module.exports = { packageRemoteRuntime };
