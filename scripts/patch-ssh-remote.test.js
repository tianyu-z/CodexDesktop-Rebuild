"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  IPC_INJECT,
  RENDERER_INJECT,
  SSH_HELPER,
  patchAppMain,
  patchAppMainIpc,
  patchRenderer,
} = require("./patch-ssh-remote");

test("Fully Remote patches CLI resolution before spawn and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-remote-patch-"));
  const bundle = path.join(dir, "src-fixture.js");
  const source = [
    "const Transport=class{",
    "async connect(){let e=lB(this.options);if(!e)throw Error(`Unable to locate the Codex CLI binary. Set CODEX_CLI_PATH`);return new oB(e)}",
    "spawnProcess(){let e=(0,f.spawn)(this.options.spawnCommand??this.options.executablePath,this.options.spawnArgs??this.options.args,{stdio:[`pipe`,`pipe`,`pipe`],env:this.options.env});return e}",
    "};",
  ].join("");
  fs.writeFileSync(bundle, source);

  assert.equal(patchAppMain([{ platform: "win", path: bundle }]), 1);
  const once = fs.readFileSync(bundle, "utf8");
  assert.match(once, /__sshRemotePatchVersion=7/);
  assert.match(once, /global\.__sshResolveCodexOptions\?global\.__sshResolveCodexOptions\(this\.options,\(\)=>lB\(this\.options\)\)/);
  assert.match(once, /spawnProcess\(\)\{__sshOverrideSpawnOptions\(this\.options\);/);

  assert.equal(patchAppMain([{ platform: "win", path: bundle }]), 1);
  assert.equal(fs.readFileSync(bundle, "utf8"), once);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Fully Remote resolves SSH without invoking the local Codex resolver", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-remote-resolver-"));
  const configPath = path.join(dir, "ssh-remote.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mode: "fully-remote",
      host: "bootstrap-host",
      hosts: ["bootstrap-host", "second-host"],
    }),
  );
  const electron = {
    app: { getPath: () => dir },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const context = {
    Buffer,
    global: {},
    process: { env: {}, platform: process.platform },
    require: (id) => (id === "electron" ? electron : require(id)),
  };
  vm.runInNewContext(SSH_HELPER, context);

  let localResolveCalls = 0;
  const resolved = context.global.__sshResolveCodexOptions({}, () => {
    localResolveCalls++;
    return { executablePath: "local-codex" };
  });

  assert.equal(localResolveCalls, 0);
  assert.equal(resolved.spawnCommand, "ssh");
  assert.ok(Array.from(resolved.spawnArgs).includes("bootstrap-host"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("bridge wraps the prepared SSH command", () => {
  const sshPreparation = SSH_HELPER.indexOf("if(__isFullyRemote(cfg)&&!options.__sshRemotePrepared)");
  const bridgePreparation = SSH_HELPER.indexOf("var __ccDir=");
  assert.ok(sshPreparation >= 0);
  assert.ok(bridgePreparation > sshPreparation);
  assert.match(SSH_HELPER, /options\.spawnArgs=\[__wrap,__oc\]\.concat\(__oa\)/);
  assert.match(SSH_HELPER, /process\.resourcesPath,"cua_node","bin",__nodeName/);
  assert.match(SSH_HELPER, /options\.spawnCommand=__node/);
});

test("IPC bootstrap tolerates an unavailable safeStorage binding", () => {
  const channels = [];
  const electron = {
    app: { getPath: () => os.tmpdir(), relaunch() {}, exit() {} },
    ipcMain: { handle: (channel) => channels.push(channel) },
  };
  Object.defineProperty(electron, "safeStorage", {
    get() {
      throw new Error("No such binding was linked: electron_browser_safe_storage");
    },
  });
  const context = {
    Buffer,
    clearTimeout,
    console,
    global: {},
    require: (id) => (id === "electron" ? electron : require(id)),
    setTimeout,
  };

  assert.doesNotThrow(() => vm.runInNewContext(IPC_INJECT, context));
  assert.deepEqual(channels, [
    "ssh-remote:read",
    "ssh-remote:write",
    "ssh-remote:list-hosts",
    "ssh-remote:restart",
  ]);
});

test("IPC patch upgrades an existing injected block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-remote-ipc-patch-"));
  const bundle = path.join(dir, "main-fixture.js");
  fs.writeFileSync(
    bundle,
    `before;/*__SSH_REMOTE_IPC_START__*/legacy/*__SSH_REMOTE_IPC_END__*/;after`,
  );

  assert.equal(patchAppMainIpc([{ platform: "win", path: bundle }]), 1);
  const once = fs.readFileSync(bundle, "utf8");
  assert.match(once, /var __safe=null;\ntry\{__safe=__electron\.safeStorage;\}catch\(e\)\{\}/);
  assert.doesNotMatch(once, /legacy/);
  assert.equal(patchAppMainIpc([{ platform: "win", path: bundle }]), 1);
  assert.equal(fs.readFileSync(bundle, "utf8"), once);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderer uses the native Connections SSH form without a startup overlay", () => {
  assert.doesNotThrow(() => new vm.Script(RENDERER_INJECT));
  assert.match(RENDERER_INJECT, /settings\\\/connections/);
  assert.match(RENDERER_INJECT, /\^Connections\$/);
  assert.match(RENDERER_INJECT, /Add manually/);
  assert.match(RENDERER_INJECT, /installDiscoveryForm/);
  assert.match(RENDERER_INJECT, /Select at least one SSH connection/);
  assert.match(RENDERER_INJECT, /hosts:aliases/);
  assert.doesNotMatch(RENDERER_INJECT, /aliases\.length!==1/);
  assert.match(RENDERER_INJECT, /readNativeFields/);
  assert.match(RENDERER_INJECT, /new MutationObserver\(queueScan\)/);
  assert.match(RENDERER_INJECT, /openNativeIfPending/);
  assert.doesNotMatch(RENDERER_INJECT, /var sshTitle=/);
  assert.doesNotMatch(RENDERER_INJECT, /__ssh-remote-overlay/);
  assert.doesNotMatch(RENDERER_INJECT, /addGear\(/);
});

test("renderer patch upgrades the legacy modal and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-remote-renderer-"));
  const bundle = path.join(dir, "renderer-fixture.js");
  fs.writeFileSync(
    bundle,
    `before;/*__SSH_REMOTE_RENDERER_START__*/legacy/*__SSH_REMOTE_RENDERER_END__*/;after`,
  );

  assert.equal(patchRenderer([{ platform: "win", path: bundle }]), 1);
  const once = fs.readFileSync(bundle, "utf8");
  assert.match(once, /installPageControl/);
  assert.doesNotMatch(once, /legacy/);
  assert.equal(patchRenderer([{ platform: "win", path: bundle }]), 1);
  assert.equal(fs.readFileSync(bundle, "utf8"), once);
  fs.rmSync(dir, { recursive: true, force: true });
});
