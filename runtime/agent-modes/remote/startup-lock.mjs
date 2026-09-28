import { spawn } from 'node:child_process';

// A kernel advisory lock survives stale files and is released on process exit.
// Python's standard fcntl module is available on the supported SSH clusters.
const program = `import os,sys,stat,fcntl
p=sys.argv[1]
fd=os.open(p,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
s=os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode & 0o077:
 raise RuntimeError("Startup lock is not private")
fcntl.flock(fd,fcntl.LOCK_EX)
print("LOCKED",flush=True)
sys.stdin.buffer.read()
`;
export async function acquireStartupLock(path, { timeoutMs = 45000 } = {}) {
  const child = spawn('python3', ['-u', '-c', program, path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let release, locked = false, settled = false;
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); finish(Error('Remote gateway startup lock timed out.')); }, timeoutMs);
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      let output = '';
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('LOCKED\n')) { locked = true; finish(); } });
      child.stderr.resume();
      child.on('error', () => finish(Error('Remote engine startup requires Python 3 with fcntl.')));
      child.once('close', () => { if (!locked) finish(Error('Could not acquire private remote gateway startup lock.')); });
    });
    release = async () => { child.stdin.end(); await exited; };
    return release;
  } catch (error) { child.kill(); await exited; throw error; }
}
