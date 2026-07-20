#!/usr/bin/env node
/**
 * cdp-harness.js — minimal Chrome DevTools Protocol driver for the Codex desktop app.
 *
 * Attaches to a running Electron app that was launched with
 *   --remote-debugging-port=<PORT>
 * finds the main renderer target (the app UI, not devtools/extensions), and
 * evaluates arbitrary JS in it via Runtime.evaluate.
 *
 * Usage:
 *   node scripts/cdp-harness.js targets                 # list debuggable targets
 *   node scripts/cdp-harness.js eval "<js expression>"  # eval in main renderer, print result
 *   node scripts/cdp-harness.js evalfile <path.js>      # eval file contents (awaited) in renderer
 *
 * Env: CDP_PORT (default 9222).
 */
const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");

const PORT = process.env.CDP_PORT ? Number(process.env.CDP_PORT) : 9222;

function httpJson(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path: pathname }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("bad JSON from " + pathname + ": " + body.slice(0, 200)));
          }
        });
      })
      .on("error", reject);
  });
}

async function listTargets() {
  const list = await httpJson("/json/list");
  return list;
}

// Pick the main app renderer: a "page" target whose URL is the app (not devtools://,
// not about:blank, prefer one that has a title/url mentioning the app or a file/https URL).
function pickRenderer(targets) {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (pages.length === 0) return null;
  // Prefer non-devtools, non-blank, with a real URL.
  const real = pages.filter(
    (t) => !/^devtools:/.test(t.url) && t.url !== "about:blank" && !/^chrome-extension:/.test(t.url)
  );
  const pool = real.length ? real : pages;
  // Prefer the one whose URL looks like the app shell (index.html / app).
  pool.sort((a, b) => {
    const score = (t) =>
      (/index\.html|app|webview/i.test(t.url) ? 2 : 0) + (t.url.startsWith("file:") || t.url.startsWith("https:") ? 1 : 0);
    return score(b) - score(a);
  });
  return pool[0];
}

let _msgId = 0;
function cdpSend(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id === id) {
        ws.off("message", onMsg);
        if (msg.error) reject(new Error(method + " failed: " + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function withRenderer(fn) {
  const targets = await listTargets();
  const target = pickRenderer(targets);
  if (!target) throw new Error("no renderer target found (is the app running with --remote-debugging-port=" + PORT + "?)");
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  try {
    return await fn(ws);
  } finally {
    ws.close();
  }
}

async function evalOnWs(ws, expression, { awaitPromise = true } = {}) {
  await cdpSend(ws, "Runtime.enable");
  const r = await cdpSend(ws, "Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails;
    throw new Error("eval exception: " + (ex.exception?.description || ex.text || JSON.stringify(ex)));
  }
  return r.result?.value;
}

async function evalInRenderer(expression, opts = {}) {
  return withRenderer((ws) => evalOnWs(ws, expression, opts));
}

// Trusted click via CDP Input domain — required because React ignores synthetic
// (untrusted) MouseEvents, so `element.click()` in eval does not trigger navigation.
// Resolves the selector's center in the renderer, then dispatches real mouse events.
async function clickSelector(selector, { index = 0 } = {}) {
  return withRenderer(async (ws) => {
    const expr =
      "(function(){var els=document.querySelectorAll(" +
      JSON.stringify(selector) +
      ");var el=els[" +
      index +
      "];if(!el)return null;el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height});})()";
    const raw = await evalOnWs(ws, expr);
    if (!raw) throw new Error("selector not found: " + selector + " [" + index + "]");
    const box = JSON.parse(raw);
    await cdpSend(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdpSend(ws, "Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
    return box;
  });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "targets") {
    const t = await listTargets();
    console.log(
      JSON.stringify(
        t.map((x) => ({ type: x.type, title: x.title, url: (x.url || "").slice(0, 80) })),
        null,
        2
      )
    );
    const r = pickRenderer(t);
    console.log("\n[picked renderer]:", r ? { title: r.title, url: (r.url || "").slice(0, 100) } : null);
    return;
  }
  if (cmd === "eval") {
    const val = await evalInRenderer(arg);
    console.log(typeof val === "string" ? val : JSON.stringify(val, null, 2));
    return;
  }
  if (cmd === "evalfile") {
    const src = fs.readFileSync(arg, "utf-8");
    // Wrap so top-level await works and a returned value is captured.
    const wrapped = "(async()=>{" + src + "})()";
    const val = await evalInRenderer(wrapped);
    console.log(typeof val === "string" ? val : JSON.stringify(val, null, 2));
    return;
  }
  if (cmd === "click") {
    // click "<css selector>" [index]
    const idx = process.argv[4] ? parseInt(process.argv[4], 10) : 0;
    const box = await clickSelector(arg, { index: idx });
    console.log("clicked " + arg + " [" + idx + "] at " + JSON.stringify(box));
    return;
  }
  if (cmd === "key") {
    // key "Enter"  — dispatch a trusted key press (React-honored)
    await withRenderer(async (ws) => {
      for (const type of ["keyDown", "keyUp"]) {
        await cdpSend(ws, "Input.dispatchKeyEvent", {
          type,
          key: arg,
          code: arg,
          windowsVirtualKeyCode: arg === "Enter" ? 13 : 0,
          nativeVirtualKeyCode: arg === "Enter" ? 13 : 0,
        });
      }
    });
    console.log("pressed " + arg);
    return;
  }
  console.error("usage: cdp-harness.js targets | eval <js> | evalfile <path> | click <selector> [index] | key <keyName>");
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[cdp-harness error]", e.message);
    process.exit(1);
  });
}

module.exports = { evalInRenderer, listTargets, pickRenderer };
