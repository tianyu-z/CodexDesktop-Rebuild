#!/usr/bin/env node
// Phase-0 capture: tee the codex app-server stdio between the desktop and the
// real codex binary, logging both directions raw (Content-Length frames intact).
const { spawn } = require("child_process");
const fs = require("fs"); const path = require("path"); const os = require("os");
const dir = path.join(os.homedir(), ".codex", "cc-bridge");
const logFile = path.join(dir, "capture.log");
const NL = String.fromCharCode(10);
function log(tag, buf){
  try {
    fs.appendFileSync(logFile, NL + "===== " + tag + " " + new Date().toISOString() + " (" + buf.length + "b) =====" + NL);
    fs.appendFileSync(logFile, buf);
  } catch (e) {}
}
const cmd = process.argv[2]; const args = process.argv.slice(3);
log("SPAWN", Buffer.from(cmd + " " + args.join(" ")));
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.on("data", d => { log("C2S", d); try { child.stdin.write(d); } catch (e) {} });
child.stdout.on("data", d => { log("S2C", d); try { process.stdout.write(d); } catch (e) {} });
process.stdin.on("end", () => { try { child.stdin.end(); } catch (e) {} });
child.on("exit", c => process.exit(c || 0));
child.on("error", e => { log("ERR", Buffer.from(String(e))); process.exit(1); });
