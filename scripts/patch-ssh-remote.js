#!/usr/bin/env node
/**
 * patch-ssh-remote.js — Add "Fully Remote" SSH mode.
 *
 * Integrates with the native Connections UI and intercepts the desktop
 * `codex app-server` spawn to tunnel it over SSH in Fully Remote mode.
 *
 * Two layers:
 *   1. app-main chunk  — wrap the codex app-server spawn with an SSH
 *                        transport that reads ~/.config/codex/ssh-remote.json
 *   2. renderer chunk  — inject a React mode-selector page that is shown
 *                        once (before login) and whenever the user switches
 *                        modes via a settings entry.
 *
 * SSH transport uses the system `ssh` binary so no extra npm deps are needed.
 * Supports: key file (-i), jump/bastion host (-J), SSH agent (default),
 * password via SSH_ASKPASS helper, and a custom remote codex path.
 *
 * Config schema (userData/ssh-remote.json):
 * {
 *   "mode": "local" | "fully-remote",
 *   "host": "ssh-bootstrap-alias",
 *   "hosts": ["ssh-bootstrap-alias", "other-native-connection"],
 *   "port": 22,                      // optional
 *   "identityFile": "/path/to/key",  // optional
 *   "jumpHost": "user@bastion",      // optional
 *   "passwordEncrypted": "...",      // optional, encrypted by safeStorage
 *   "codexPath": "codex"             // optional, defaults to "codex"
 * }
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

// Resolve the renderer ENTRY bundle per platform by reading index.html.
// There are several index-*.js chunks; only the one index.html loads actually
// executes, so a blind /^index-.*\.js$/ match can patch a dead chunk.
function locateRendererEntry(opts) {
  const platforms = opts.platform ? [opts.platform] : ["mac-arm64", "mac-x64", "win"];
  const results = [];
  for (const plat of platforms) {
    const webviewDir = path.join(SRC_DIR, plat, "_asar", "webview");
    const indexHtml = path.join(webviewDir, "index.html");
    if (!fs.existsSync(indexHtml)) continue;
    const html = fs.readFileSync(indexHtml, "utf-8");
    const m = html.match(/src="\.?\/?assets\/(index-[A-Za-z0-9_-]+\.js)"/);
    if (!m) { console.warn(`  [!] ${plat}: entry script not found in index.html`); continue; }
    const entry = path.join(webviewDir, "assets", m[1]);
    if (fs.existsSync(entry)) results.push({ platform: plat, path: entry });
    else console.warn(`  [!] ${plat}: entry ${m[1]} referenced but missing`);
  }
  return results;
}

// ─── Injected SSH spawn helper (runs in Electron main process) ──────────────
//
// This string is injected verbatim at the top of the app-main bundle.
// It defines __sshSpawnCodexAppServer() which is called instead of the
// normal spawn when mode === "fully-remote".
//
// The function returns a ChildProcess-compatible object with the same
// .stdin/.stdout/.stderr/.on() interface so the rest of the app is unaware.

const SSH_HELPER_START = ";/*__SSH_REMOTE_HELPER_START__*/";
const SSH_HELPER_END = "/*__SSH_REMOTE_HELPER_END__*/;";
const SSH_PATCH_VERSION = 7;

const SSH_HELPER = `
${SSH_HELPER_START}
;(function(){
var __os=require("os"),__fs=require("fs"),__path=require("path"),__electron=require("electron");
global.__sshRemotePatchVersion=${SSH_PATCH_VERSION};
function __decryptPassword(cfg){
  if(!cfg||cfg.password||!cfg.passwordEncrypted)return cfg;
  try{
    if(__electron.safeStorage&&__electron.safeStorage.isEncryptionAvailable()){
      cfg.password=__electron.safeStorage.decryptString(Buffer.from(cfg.passwordEncrypted,"base64"));
    }
  }catch(e){}
  return cfg;
}
function __readSshConfig(){
  try{
    var p=__path.join(
      (__electron&&__electron.app)
        ?__electron.app.getPath("userData")
        :__path.join(__os.homedir(),".config","codex"),
      "ssh-remote.json");
    if(__fs.existsSync(p))return __decryptPassword(JSON.parse(__fs.readFileSync(p,"utf8")));
  }catch(e){}
  return null;
}
// Build ssh argv (+ env) from our config. When host is a ~/.ssh/config alias and
// the other fields are empty, ssh itself resolves HostName/User/IdentityFile/
// ProxyCommand/keepalives from ~/.ssh/config — so ProxyCommand jump hosts, agent
// keys, etc. all work with just {host:"<alias>"}. Explicit fields below are for
// ad-hoc hosts not in the config.
function __sshBuildArgs(cfg,baseEnv,codexArgs){
  var sshArgs=["-T","-o","StrictHostKeyChecking=accept-new"];
  if(cfg.port)sshArgs.push("-p",String(cfg.port));
  if(cfg.identityFile)sshArgs.push("-i",cfg.identityFile);
  if(cfg.jumpHost)sshArgs.push("-J",cfg.jumpHost);
  if(cfg.proxyCommand)sshArgs.push("-o","ProxyCommand="+cfg.proxyCommand);
  sshArgs.push(cfg.host,cfg.codexPath||"codex");
  var remoteArgs=Array.isArray(codexArgs)&&codexArgs.length?codexArgs:["-c","features.code_mode_host=true","app-server","--analytics-default-enabled"];
  for(var i=0;i<remoteArgs.length;i++)sshArgs.push(String(remoteArgs[i]));
  var env=Object.assign({},baseEnv||process.env);
  if(cfg.password){
    // Password auth without a private key: hand ssh a SSH_ASKPASS helper that
    // prints the saved password. Works for both password and keyboard-interactive
    // prompts via SSH_ASKPASS_REQUIRE=force. The password is passed through an env
    // var (CC_SSH_PW) and echoed by a tiny node script, so special characters in
    // the password never need shell/cmd escaping.
    var isWin=process.platform==="win32";
    var askDir=__path.join(__os.tmpdir(),"codex-ssh-askpass");
    try{__fs.mkdirSync(askDir,{recursive:true});}catch(e){}
    var askPath=__path.join(askDir,isWin?"askpass.cmd":"askpass.sh");
    if(isWin){
      __fs.writeFileSync(askPath,"@node -e \\"process.stdout.write(process.env.CC_SSH_PW||'')\\"\\r\\n");
    }else{
      __fs.writeFileSync(askPath,"#!/bin/sh\\nnode -e \\"process.stdout.write(process.env.CC_SSH_PW||'')\\"\\n");
      try{__fs.chmodSync(askPath,0o700);}catch(e){}
    }
    env.SSH_ASKPASS=askPath;
    env.SSH_ASKPASS_REQUIRE="force";
    env.CC_SSH_PW=String(cfg.password);
    if(!isWin)env.DISPLAY=env.DISPLAY||":0";
    // Prefer password/keyboard-interactive when a password is provided and no key.
    if(!cfg.identityFile)sshArgs.push("-o","PreferredAuthentications=keyboard-interactive,password","-o","PubkeyAuthentication=no");
  }
  return {args:sshArgs,env:env};
}
function __isFullyRemote(cfg){return !!(cfg&&cfg.mode==="fully-remote"&&cfg.host);}
global.__sshIsFullyRemote=function(){return __isFullyRemote(__readSshConfig());};
// This runs before the upstream "CLI not found" check. Returning SSH options
// here makes Fully Remote independent of a local codex executable.
global.__sshResolveCodexOptions=function(options,resolveLocal){
  var cfg=__readSshConfig();
  if(!__isFullyRemote(cfg))return typeof resolveLocal==="function"?resolveLocal():resolveLocal;
  process.env.CODEX_APP_SERVER_FORCE_CLI="1";
  var b=__sshBuildArgs(cfg,process.env,null);
  return {executablePath:"ssh",args:b.args,spawnCommand:"ssh",spawnArgs:b.args,env:b.env,__sshRemotePrepared:true};
};
global.__sshSpawnCodexAppServer=function(origSpawn,origArgs,origOpts){
  var cfg=__readSshConfig();
  if(!__isFullyRemote(cfg))return origSpawn("codex",origArgs,origOpts);
  var b=__sshBuildArgs(cfg,origOpts&&origOpts.env,origArgs);
  return origSpawn("ssh",b.args,Object.assign({},origOpts,{env:b.env,shell:false,windowsHide:true}));
};
// Mutates the spawnProcess() options object in place. Called right before the
// upstream spawn: in local mode it leaves options untouched (so the normal
// codex app-server launch proceeds); in fully-remote mode it rewrites the
// command/args to tunnel through ssh. Referenced by the spawnProcess() patch.
global.__sshOverrideSpawnOptions=function(options){
  try{
    if(!options)return;
    var cfg=__readSshConfig();
    // Build the remote command first. A bridge, if present, must wrap this SSH
    // command rather than the original local codex executable.
    if(__isFullyRemote(cfg)&&!options.__sshRemotePrepared){
      var b=__sshBuildArgs(cfg,options.env,options.args);
      options.spawnCommand="ssh";options.spawnArgs=b.args;
      options.executablePath="ssh";options.args=b.args;
      options.env=b.env;options.__sshRemotePrepared=true;
    }
    // cc-bridge hooks (Claude Code backend / protocol capture). Both wrap the
    // real codex app-server spawn with a node script over the same stdio.
    try{
      var __ccDir=__path.join(__os.homedir(),".codex","cc-bridge");
      var __wrap=null;
      if(__fs.existsSync(__path.join(__ccDir,"capture"))) __wrap=__path.join(__ccDir,"tee.js");
      // Always route through the bridge when it's present: it passes through to
      // real codex transparently and only drives Claude for turns the current
      // backend/model selects — so switching harness at runtime needs no restart.
      else if(__fs.existsSync(__path.join(__ccDir,"bridge.js"))) __wrap=__path.join(__ccDir,"bridge.js");
      if(__wrap){
        var __oc=options.spawnCommand||options.executablePath;
        var __oa=(options.spawnArgs||options.args||[]).slice();
        var __nodeName=process.platform==="win32"?"node.exe":"node";
        var __nodeCandidates=[
          __path.join(process.resourcesPath,"cua_node","bin",__nodeName),
          __path.join(process.resourcesPath,__nodeName)
        ];
        var __node=__nodeCandidates.find(function(p){return __fs.existsSync(p);})||process.execPath;
        options.env=Object.assign({},options.env||process.env,{ELECTRON_RUN_AS_NODE:"1"});
        options.spawnCommand=__node;options.executablePath=__node;
        options.spawnArgs=[__wrap,__oc].concat(__oa);options.args=options.spawnArgs;
        return;
      }
    }catch(e){}
  }catch(e){}
};
global.__readSshConfig=__readSshConfig;
})();
${SSH_HELPER_END}
`;

// ─── Layer 1: app-main spawn intercept ──────────────────────────────────────

function patchAppMain(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    const hasPatchedSpawn = code.includes("spawnProcess(){__sshOverrideSpawnOptions(this.options);");
    const hasSpawnCandidate = /spawnProcess\(\)\{let \w+=\(0,\w+\.spawn\)\(this\.options\.spawnCommand\?\?this\.options\.executablePath/.test(code);
    const hasDirectCandidate = /\bspawn\((["`'])codex\1,\s*\[(["`'])app-server\2\]/.test(code);
    if (!hasPatchedSpawn && !hasSpawnCandidate && !hasDirectCandidate) {
      console.log(`  [!] ${relPath(bundle.path)}: spawn pattern not found`);
      continue;
    }
    let newCode = code;
    let changed = false;

    if (!newCode.includes(`__sshRemotePatchVersion=${SSH_PATCH_VERSION}`)) {
      let oldStart = newCode.indexOf(SSH_HELPER_START);
      let oldEnd = -1;
      let oldEndLength = 0;
      if (oldStart >= 0) {
        oldEnd = newCode.indexOf(SSH_HELPER_END, oldStart);
        oldEndLength = SSH_HELPER_END.length;
      } else {
        oldStart = newCode.indexOf(';(function(){\nvar __os=require("os"),__cp=require("child_process"),__fs=require("fs"),__path=require("path");');
      }
      if (oldStart >= 0) {
        const oldEndMarker = "global.__readSshConfig=__readSshConfig;\n})();";
        if (oldEnd < 0) {
          oldEnd = newCode.indexOf(oldEndMarker, oldStart);
          oldEndLength = oldEndMarker.length;
        }
        if (oldEnd < 0) {
          console.log(`  [!] ${relPath(bundle.path)}: old SSH helper end marker not found`);
          continue;
        }
        newCode = newCode.slice(0, oldStart) + SSH_HELPER.trimStart() + newCode.slice(oldEnd + oldEndLength);
      } else {
        newCode = SSH_HELPER + newCode;
      }
      changed = true;
    }

    // The upstream resolver returns null when no local CLI exists. Wrap it so
    // Fully Remote can return SSH spawn options before that null is rejected.
    const eagerResolveRe = /global\.__sshResolveCodexOptions\(this\.options,([A-Za-z_$][\w$]*)\(this\.options\)\)/;
    if (eagerResolveRe.test(newCode)) {
      newCode = newCode.replace(eagerResolveRe, "global.__sshResolveCodexOptions(this.options,()=>$1(this.options))");
      changed = true;
    }
    if (!newCode.includes("global.__sshResolveCodexOptions(this.options")) {
      const connectRe = /async connect\(\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(this\.options\);if\(!([A-Za-z_$][\w$]*)\)throw Error\(`Unable to locate the Codex CLI binary/;
      const connectMatch = newCode.match(connectRe);
      if (connectMatch && connectMatch[1] === connectMatch[3]) {
        const original = `let ${connectMatch[1]}=${connectMatch[2]}(this.options)`;
        const replacement = `let ${connectMatch[1]}=global.__sshResolveCodexOptions?global.__sshResolveCodexOptions(this.options,()=>${connectMatch[2]}(this.options)):${connectMatch[2]}(this.options)`;
        newCode = newCode.slice(0, connectMatch.index) + newCode.slice(connectMatch.index).replace(original, replacement);
        changed = true;
      }
    }

    if (!hasDirectCandidate && !newCode.includes("global.__sshResolveCodexOptions(this.options")) {
      console.log(`  [!] ${relPath(bundle.path)}: local CLI resolver pattern not found`);
      continue;
    }

    if (newCode.includes("spawnProcess(){__sshOverrideSpawnOptions(this.options);")) {
      if (changed) fs.writeFileSync(bundle.path, newCode);
      console.log(`  [ok] ${relPath(bundle.path)}: SSH resolver/spawn intercept ready`);
      patched++;
      continue;
    }

    // The upstream app uses a class with spawnProcess() that calls:
    //   (0,f.spawn)(this.options.spawnCommand??this.options.executablePath,
    //               this.options.spawnArgs??this.options.args,
    //               {stdio:['pipe','pipe','pipe'],env:this.options.env})
    // We intercept by wrapping the options object before spawn is called.
    // Pattern: spawnProcess(){let e=(0,X.spawn)(this.options.spawnCommand??this.options.executablePath,this.options.spawnArgs??this.options.args,{stdio:
    const spawnRe = /spawnProcess\(\)\{let (\w+)=\(0,(\w+)\.spawn\)\(this\.options\.spawnCommand\?\?this\.options\.executablePath,this\.options\.spawnArgs\?\?this\.options\.args,\{stdio:/;
    const m = newCode.match(spawnRe);
    if (!m) {
      // Fallback: direct spawn("codex",["app-server"],opts)
      const directRe = /\bspawn\((["`'])codex\1,\s*\[(["`'])app-server\2\]\s*,\s*(\w+)\)/;
      const m2 = newCode.match(directRe);
      if (!m2) {
        console.log(`  [!] ${relPath(bundle.path)}: spawn pattern not found`);
        continue;
      }
      const optsVar = m2[3];
      const replacement = `__sshSpawnCodexAppServer(spawn,["app-server"],${optsVar})`;
      const directCode = newCode.slice(0, m2.index) + replacement + newCode.slice(m2.index + m2[0].length);
      fs.writeFileSync(bundle.path, directCode);
      console.log(`  [ok] ${relPath(bundle.path)}: direct spawn intercepted`);
      patched++;
      continue;
    }

    // Inject SSH option override before the spawn call inside spawnProcess()
    const procVar = m[1];   // e
    const spawnMod = m[2];  // f
    const insertBefore = m[0];
    const sshOverride = `spawnProcess(){__sshOverrideSpawnOptions(this.options);let ${procVar}=(0,${spawnMod}.spawn)(this.options.spawnCommand??this.options.executablePath,this.options.spawnArgs??this.options.args,{stdio:`;

    newCode = newCode.replace(insertBefore, sshOverride);
    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: spawnProcess intercepted`);
    patched++;
  }
  return patched;
}

// ─── Layer 2: renderer mode-selector injection ───────────────────────────────
//
// Renders a plain-DOM mode selector — NOT React. The app bundles React in
// module scope (no window.React) and runs with contextIsolation on (no
// window.require), so the old React-wrapper approach silently no-op'd. This
// builds the overlay + floating gear with document.createElement and talks to
// the main process through window.sshRemote, a bridge we expose from preload.

const RENDERER_START = ";/*__SSH_REMOTE_RENDERER_START__*/";
const RENDERER_END = "/*__SSH_REMOTE_RENDERER_END__*/;";
const LEGACY_RENDERER_INJECT = `
${RENDERER_START}
;(function(){
if(window.__sshRemoteUiInstalled)return;
window.__sshRemoteUiInstalled=true;

var FONT="system-ui,-apple-system,Segoe UI,sans-serif";

function readCfg(cb){
  var b=window.sshRemote;
  if(!b){cb(null);return;}
  try{b.read().then(cb).catch(function(){cb(null);});}catch(e){cb(null);}
}
function writeCfg(cfg){
  var b=window.sshRemote;
  if(!b)return Promise.reject(new Error("SSH configuration bridge is unavailable"));
  try{return b.write(cfg);}catch(e){return Promise.reject(e);}
}

function el(tag,style,text){
  var n=document.createElement(tag);
  if(style)for(var k in style)n.style[k]=style[k];
  if(text!=null)n.textContent=text;
  return n;
}
function field(parent,labelText,value,placeholder,type){
  var wrap=el("div",{marginBottom:"12px"});
  wrap.appendChild(el("label",{display:"block",fontSize:"12px",color:"#999",marginBottom:"4px"},labelText));
  var inp=el("input",{width:"100%",boxSizing:"border-box",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"8px 10px",color:"#e0e0e0",fontSize:"13px"});
  inp.type=type||"text"; inp.value=value||""; inp.placeholder=placeholder||"";
  wrap.appendChild(inp); parent.appendChild(wrap);
  return inp;
}

function openModal(cfg,onClose){
  cfg=cfg||{};
  var old=document.getElementById("__ssh-remote-overlay");
  if(old)old.remove();

  var overlay=el("div",{position:"fixed",top:"0",left:"0",right:"0",bottom:"0",background:"rgba(0,0,0,0.7)",zIndex:"2147483646",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:FONT});
  overlay.id="__ssh-remote-overlay";
  var box=el("div",{background:"#1e1e1e",color:"#e0e0e0",borderRadius:"12px",padding:"32px",width:"480px",maxWidth:"90vw",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 8px 40px rgba(0,0,0,0.6)"});
  box.appendChild(el("h2",{margin:"0 0 24px",fontSize:"20px",fontWeight:"600"},"Connection Mode"));

  var mode=cfg.mode||"local";
  var row=el("div",{display:"flex",gap:"12px",marginBottom:"16px"});
  var extra=el("div");

  function styleModeBtn(btn,m){
    btn.style.border="2px solid "+(mode===m?"#7c6af7":"#444");
    btn.style.background=mode===m?"#2d2060":"#2a2a2a";
  }
  function mkModeBtn(m,label){
    var b=el("button",{flex:"1",padding:"12px 0",borderRadius:"8px",color:"#e0e0e0",cursor:"pointer",fontSize:"14px",fontWeight:"500"},label);
    b.onclick=function(){mode=m;styleModeBtn(localBtn,"local");styleModeBtn(remoteBtn,"fully-remote");extra.style.display=mode==="fully-remote"?"block":"none";};
    return b;
  }
  var localBtn=mkModeBtn("local","Local + Remote");
  var remoteBtn=mkModeBtn("fully-remote","Fully Remote (SSH)");
  styleModeBtn(localBtn,"local"); styleModeBtn(remoteBtn,"fully-remote");
  row.appendChild(localBtn); row.appendChild(remoteBtn);
  box.appendChild(row);

  var pu="",ph=cfg.host||"";
  if(ph.indexOf("@")>=0){var parts=ph.split("@");pu=parts[0];ph=parts.slice(1).join("@");}
  var f={};
  f.host=field(extra,"Remote Host",ph,"hostname or IP");
  f.user=field(extra,"SSH User",pu,"username (optional if in host)");
  f.port=field(extra,"Port",cfg.port!=null?String(cfg.port):"","22 (default)");
  f.identityFile=field(extra,"Identity File (optional)",cfg.identityFile||"","/path/to/id_rsa");
  f.jumpHost=field(extra,"Jump / Bastion Host — ProxyJump (optional)",cfg.jumpHost||"","user@bastion");
  f.proxyCommand=field(extra,"ProxyCommand (optional)",cfg.proxyCommand||"","ssh -W %h:%p user@login");
  f.password=field(extra,"Password (optional)","",cfg.hasPassword?"saved; leave blank to keep":"leave blank to use key/agent","password");
  f.codexPath=field(extra,"Remote codex path (optional)",cfg.codexPath||"","codex (default: $PATH)");
  // ~/.ssh/config import — pick a Host alias and let ssh resolve everything
  // (HostName, User, IdentityFile, ProxyCommand, keepalives) from the config.
  var importWrap=el("div",{marginBottom:"16px",padding:"12px",background:"#252525",borderRadius:"8px",border:"1px solid #3a3a3a"});
  importWrap.appendChild(el("label",{display:"block",fontSize:"12px",color:"#9a9",marginBottom:"6px",fontWeight:"600"},"Import from ~/.ssh/config"));
  var sel=el("select",{width:"100%",boxSizing:"border-box",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"8px 10px",color:"#e0e0e0",fontSize:"13px"});
  var opt0=el("option",null,"— pick a host —"); opt0.value=""; sel.appendChild(opt0);
  importWrap.appendChild(sel);
  var info=el("div",{marginTop:"8px",fontSize:"11px",color:"#7a9a7a",whiteSpace:"pre-wrap",lineHeight:"1.5"});
  importWrap.appendChild(info);
  var hostMap={};
  if(window.sshRemote&&window.sshRemote.listHosts){
    window.sshRemote.listHosts().then(function(list){
      (list||[]).forEach(function(h){
        hostMap[h.alias]=h;
        var o=el("option",null,h.alias+(h.hostName&&h.hostName!==h.alias?"  ("+h.hostName+")":""));
        o.value=h.alias; sel.appendChild(o);
      });
      if(!list||!list.length){info.textContent="No hosts found in ~/.ssh/config";}
    }).catch(function(){info.textContent="Could not read ~/.ssh/config";});
  }
  sel.onchange=function(){
    var h=hostMap[sel.value];
    if(!h){info.textContent="";return;}
    // Use the alias only; clear manual fields so ssh's own config drives it.
    f.host.value=h.alias;
    f.user.value=""; f.port.value=""; f.identityFile.value=""; f.jumpHost.value=""; f.proxyCommand.value="";
    var lines=[];
    if(h.hostName)lines.push("HostName: "+h.hostName);
    if(h.user)lines.push("User: "+h.user);
    if(h.identityFile)lines.push("IdentityFile: "+h.identityFile);
    if(h.proxyCommand)lines.push("ProxyCommand: "+h.proxyCommand);
    else if(h.proxyJump)lines.push("ProxyJump: "+h.proxyJump);
    lines.push("→ ssh "+h.alias+" codex app-server");
    info.textContent=lines.join("\\n");
  };
  extra.insertBefore(importWrap,extra.firstChild);

  extra.style.display=mode==="fully-remote"?"block":"none";
  box.appendChild(extra);

  var error=el("div",{display:"none",margin:"4px 0 10px",padding:"8px 10px",borderRadius:"6px",background:"#3a1f24",color:"#ffb4bd",fontSize:"12px",lineHeight:"1.4"});
  box.appendChild(error);
  var save=el("button",{marginTop:"8px",width:"100%",padding:"10px 0",borderRadius:"8px",border:"none",background:"#7c6af7",color:"#fff",fontSize:"15px",fontWeight:"600",cursor:"pointer"},"Save & Restart");
  save.onclick=function(){
    save.disabled=true; save.textContent="Saving…";
    var hostVal=f.host.value.trim(), userVal=f.user.value.trim();
    error.style.display="none";
    if(mode==="fully-remote"&&!hostVal){save.disabled=false;save.textContent="Save & Restart";error.textContent="Remote host is required.";error.style.display="block";f.host.focus();return;}
    var portVal=f.port.value.trim()?parseInt(f.port.value,10):undefined;
    if(portVal!=null&&(!Number.isInteger(portVal)||portVal<1||portVal>65535)){save.disabled=false;save.textContent="Save & Restart";error.textContent="Port must be between 1 and 65535.";error.style.display="block";f.port.focus();return;}
    var c={
      mode:mode,
      host:hostVal?(userVal?userVal+"@"+hostVal:hostVal):"",
      port:portVal,
      identityFile:f.identityFile.value.trim()||undefined,
      jumpHost:f.jumpHost.value.trim()||undefined,
      proxyCommand:f.proxyCommand.value.trim()||undefined,
      password:f.password.value||undefined,
      keepPassword:!!cfg.hasPassword&&!f.password.value,
      codexPath:f.codexPath.value.trim()||undefined
    };
    writeCfg(c).then(function(){
      save.textContent="Restarting...";
      if(!window.sshRemote.restart)throw new Error("Restart bridge is unavailable");
      return window.sshRemote.restart();
    }).catch(function(e){
      save.disabled=false;save.textContent="Save & Restart";
      error.textContent=(e&&e.message)||String(e)||"Unable to save configuration";error.style.display="block";
    });
  };
  box.appendChild(save);

  overlay.appendChild(box);
  (document.body||document.documentElement).appendChild(overlay);
}

function addGear(){
  if(document.getElementById("__ssh-remote-gear"))return;
  var g=el("button",{position:"fixed",bottom:"16px",right:"16px",zIndex:"2147483645",width:"36px",height:"36px",borderRadius:"50%",background:"#2a2a2a",border:"1px solid #555",color:"#aaa",fontSize:"18px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.4)",fontFamily:FONT},"\\u2699");
  g.id="__ssh-remote-gear";
  g.title="Connection mode";
  g.onclick=function(){readCfg(function(c){openModal(c||{},null);});};
  (document.body||document.documentElement).appendChild(g);
}

function init(){
  addGear();
  readCfg(function(c){ if(!c||!c.mode||(c.mode==="fully-remote"&&!c.host))openModal(c||{},null); });
}

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);
else init();
})();
${RENDERER_END}
`;

// Integrate Fully Remote with the app's native Connections page and SSH form.
// The legacy overlay above remains only so previously patched bundles can be
// recognized and upgraded without depending on upstream minified code.
const RENDERER_INJECT = `
${RENDERER_START}
;(function(){
if(window.__sshRemoteUiInstalled)return;
window.__sshRemoteUiInstalled=true;

var currentCfg={mode:"local"};
var pendingFull=false;
var pendingSubmit=null;
var restartStarted=false;
var scanQueued=false;
var knownHosts=[];
var pendingOpenNative=false;

function readCfg(cb){
  var b=window.sshRemote;
  if(!b){cb(null);return;}
  try{b.read().then(cb).catch(function(){cb(null);});}catch(e){cb(null);}
}
function writeCfg(cfg){
  var b=window.sshRemote;
  if(!b)return Promise.reject(new Error("SSH configuration bridge is unavailable"));
  try{return b.write(cfg);}catch(e){return Promise.reject(e);}
}
function el(tag,style,textValue){
  var n=document.createElement(tag);
  if(style)for(var k in style)n.style[k]=style[k];
  if(textValue!=null)n.textContent=textValue;
  return n;
}
function nodeText(n){return String(n&&n.textContent||"").replace(/\\s+/g," ").trim();}
function buttons(root,label){
  return Array.prototype.filter.call((root||document).querySelectorAll("button"),function(b){return nodeText(b)===label&&!b.disabled;});
}
function findHeading(root,re){
  return Array.prototype.find.call((root||document).querySelectorAll("h1,h2,h3,h4,[role=heading]"),function(h){return re.test(nodeText(h));});
}
function styleModeButton(button,selected){
  button.style.border="0";
  button.style.borderRadius="5px";
  button.style.padding="5px 8px";
  button.style.fontSize="12px";
  button.style.lineHeight="16px";
  button.style.cursor="pointer";
  button.style.color="inherit";
  button.style.background=selected?"var(--token-bg-elevated-secondary,rgba(127,127,127,.22))":"transparent";
  button.setAttribute("aria-pressed",selected?"true":"false");
}
function modeControl(mode,onChange,id){
  var wrap=el("div",{display:"inline-flex",alignItems:"center",gap:"8px",minWidth:"0"});
  wrap.id=id;
  wrap.appendChild(el("span",{fontSize:"12px",whiteSpace:"nowrap",color:"var(--token-text-secondary,currentColor)"},"Connection mode"));
  var group=el("div",{display:"inline-flex",padding:"2px",border:"1px solid var(--token-border-light,rgba(127,127,127,.28))",borderRadius:"7px",background:"var(--token-bg-secondary,rgba(127,127,127,.08))"});
  group.setAttribute("role","group");
  group.setAttribute("aria-label","Connection mode");
  var local=el("button",null,"Local + Remote");
  var full=el("button",null,"Fully Remote");
  local.type="button";full.type="button";
  function select(next,notify){
    mode=next;
    styleModeButton(local,mode==="local");
    styleModeButton(full,mode==="fully-remote");
    if(notify)onChange(next);
  }
  local.onclick=function(){select("local",true);};
  full.onclick=function(){select("fully-remote",true);};
  group.appendChild(local);group.appendChild(full);wrap.appendChild(group);
  select(mode,false);
  return wrap;
}
function configFor(mode,fields){
  var c={mode:mode,host:fields&&fields.host!=null?fields.host:currentCfg.host||""};
  if(fields&&Array.isArray(fields.hosts))c.hosts=fields.hosts.slice();
  else if(fields&&fields.host)c.hosts=[fields.host];
  else if(Array.isArray(currentCfg.hosts))c.hosts=currentCfg.hosts.slice();
  ["port","identityFile","jumpHost","proxyCommand","codexPath"].forEach(function(k){
    var hasField=fields&&Object.prototype.hasOwnProperty.call(fields,k);
    var value=hasField?fields[k]:currentCfg[k];
    if(value!=null&&value!=="")c[k]=value;
  });
  if(currentCfg.hasPassword&&!fields)c.keepPassword=true;
  return c;
}
function persistAndRestart(cfg){
  if(restartStarted)return;
  restartStarted=true;
  writeCfg(cfg).then(function(){
    currentCfg=cfg;
    if(!window.sshRemote||!window.sshRemote.restart)throw new Error("Restart bridge is unavailable");
    return window.sshRemote.restart();
  }).catch(function(e){
    restartStarted=false;
    window.alert((e&&e.message)||String(e)||"Unable to save connection mode");
  });
}
function inputFor(form,labelRe){
  var labels=form.querySelectorAll("label");
  for(var i=0;i<labels.length;i++){
    if(!labelRe.test(nodeText(labels[i])))continue;
    var input=labels[i].querySelector("input");
    if(input)return input;
  }
  return null;
}
function readNativeFields(form){
  var host=inputFor(form,/^(Alias|Hostname)$/i);
  var port=inputFor(form,/^SSH port(?: Optional)?$/i);
  var identity=inputFor(form,/^Identity file path$/i);
  var portValue=port&&port.value.trim()?parseInt(port.value.trim(),10):undefined;
  return {
    host:host?host.value.trim():"",
    port:portValue,
    identityFile:identity?identity.value.trim()||undefined:undefined,
    jumpHost:"",
    proxyCommand:""
  };
}
function selectedAlias(dialog){
  var selected=dialog.querySelectorAll('[role="checkbox"][data-state="checked"],[role="checkbox"][aria-checked="true"],input[type="checkbox"]:checked');
  var aliases=[];
  for(var i=0;i<selected.length;i++){
    var node=selected[i];
    var aria=node.getAttribute&&node.getAttribute("aria-label")||"";
    var ariaMatches=knownHosts.filter(function(host){return aria.indexOf(host.alias)>=0;});
    if(ariaMatches.length===1){aliases.push(ariaMatches[0].alias);continue;}
    var ariaAlias=aria.replace(/^Select\\s+/i,"").trim();
    if(ariaAlias&&ariaAlias!==aria){aliases.push(ariaAlias);continue;}
    while(node&&node!==dialog){
      var rowText=nodeText(node);
      var matches=knownHosts.filter(function(host){
        if(rowText===host.alias)return true;
        return Array.prototype.some.call(node.querySelectorAll("*"),function(child){return nodeText(child)===host.alias;});
      });
      if(matches.length===1){aliases.push(matches[0].alias);break;}
      node=node.parentElement;
    }
  }
  return aliases.filter(function(alias,index){return aliases.indexOf(alias)===index;});
}
function installDiscoveryForm(dialog,form){
  if(form.__sshRemoteInstalled)return;
  form.__sshRemoteInstalled=true;
  var selected=pendingFull||currentCfg.mode==="fully-remote"?"fully-remote":"local";
  var control=modeControl(selected,function(next){pendingFull=next==="fully-remote";},"__ssh-remote-dialog-mode");
  control.style.margin="0 0 16px 0";
  form.insertBefore(control,form.firstChild);
  form.addEventListener("submit",function(e){
    var active=control.querySelector('[aria-pressed="true"]');
    var mode=active&&nodeText(active)==="Fully Remote"?"fully-remote":"local";
    if(mode==="local"&&currentCfg.mode!=="fully-remote")return;
    var aliases=selectedAlias(dialog);
    if(mode==="fully-remote"&&aliases.length===0){
      e.preventDefault();
      window.alert("Select at least one SSH connection for Fully Remote mode.");
      return;
    }
    // Native Connections saves every alias; the first only bootstraps the
    // desktop app-server that must exist before those connections are loaded.
    pendingSubmit={dialog:dialog,cfg:configFor(mode,{host:aliases[0]||currentCfg.host||"",hosts:aliases,port:"",identityFile:"",jumpHost:"",proxyCommand:""})};
  },true);
  dialog.addEventListener("click",function(e){
    var button=e.target&&e.target.closest?e.target.closest("button"):null;
    var label=nodeText(button);
    if((label==="Cancel"||label==="Close")&&!pendingSubmit)pendingFull=false;
  },true);
}
function installNativeForm(dialog){
  var form=dialog.querySelector("form");
  if(!form||form.__sshRemoteInstalled)return;
  form.__sshRemoteInstalled=true;
  var selected=pendingFull||currentCfg.mode==="fully-remote"?"fully-remote":"local";
  var control=modeControl(selected,function(next){pendingFull=next==="fully-remote";},"__ssh-remote-dialog-mode");
  control.style.marginBottom="16px";
  var first=form.querySelector("label");
  var anchor=first;
  while(anchor&&anchor.parentElement!==form)anchor=anchor.parentElement;
  form.insertBefore(control,anchor||form.firstChild);
  form.addEventListener("submit",function(){
    var active=control.querySelector('[aria-pressed="true"]');
    var mode=active&&nodeText(active)==="Fully Remote"?"fully-remote":"local";
    if(mode==="local"&&currentCfg.mode!=="fully-remote")return;
    var fields=readNativeFields(form);
    if(mode==="fully-remote"&&!fields.host)return;
    pendingSubmit={dialog:dialog,cfg:configFor(mode,fields)};
  },true);
  dialog.addEventListener("click",function(e){
    var button=e.target&&e.target.closest?e.target.closest("button"):null;
    var label=nodeText(button);
    if((label==="Cancel"||label==="Close")&&!pendingSubmit)pendingFull=false;
  },true);
}
function installDialogs(){
  var dialogs=document.querySelectorAll('[role="dialog"]');
  for(var i=0;i<dialogs.length;i++){
    if(!findHeading(dialogs[i],/^(Add|Edit) SSH connection$/i))continue;
    var addManually=buttons(dialogs[i],"Add manually")[0];
    if(addManually){
      var discoveryForm=dialogs[i].querySelector("form");
      if(discoveryForm)installDiscoveryForm(dialogs[i],discoveryForm);
      continue;
    }
    installNativeForm(dialogs[i]);
  }
}
function isConnectionsPage(){
  return /\\/settings\\/connections(?:[/?#]|$)/i.test(location.href)||!!findHeading(document,/^Connections$/i);
}
function findSshSection(){
  return Array.prototype.find.call(document.querySelectorAll("main section,section"),function(section){
    return !!findHeading(section,/SSH/i);
  });
}
function findNativeAdd(section){
  if(!section)return null;
  var headerButton=section.querySelector(":scope > div:first-child button:not([aria-pressed])");
  if(headerButton&&!headerButton.disabled)return headerButton;
  var named=buttons(section,"Add")[0];
  if(named)return named;
  return Array.prototype.find.call(section.querySelectorAll("button"),function(button){
    return !button.disabled&&!button.closest("#__ssh-remote-page-mode")&&button.getAttribute("role")!=="checkbox";
  })||null;
}
function openNativeIfPending(){
  if(!pendingOpenNative)return;
  var section=findSshSection();
  if(!section){
    var sshTab=buttons(document,"SSH")[0];
    if(sshTab&&!sshTab.__sshRemoteRequested){sshTab.__sshRemoteRequested=true;sshTab.click();}
    return;
  }
  var add=findNativeAdd(section);
  if(add){pendingOpenNative=false;add.click();}
}
function installPageControl(){
  if(!isConnectionsPage()||document.getElementById("__ssh-remote-page-mode"))return;
  var main=document.querySelector("main")||document;
  var pageTitle=main.querySelector("h1")||findHeading(main,/^Connections$/i);
  if(!pageTitle)return;
  var selected=pendingFull?"fully-remote":currentCfg.mode||"local";
  var control=modeControl(selected,function(next){
    if(next==="local"){
      pendingFull=false;
      pendingOpenNative=false;
      if(currentCfg.mode==="fully-remote")persistAndRestart(configFor("local"));
      return;
    }
    if(currentCfg.host){persistAndRestart(configFor("fully-remote"));return;}
    pendingFull=true;
    pendingOpenNative=true;
    queueScan();
  },"__ssh-remote-page-mode");
  control.style.marginLeft="auto";
  var header=pageTitle.closest("header")||pageTitle.parentElement;
  header.style.flexWrap="wrap";
  header.appendChild(control);
}
function finishNativeSave(){
  if(!pendingSubmit||document.documentElement.contains(pendingSubmit.dialog))return;
  var cfg=pendingSubmit.cfg;
  pendingSubmit=null;pendingFull=false;
  persistAndRestart(cfg);
}
function scan(){scanQueued=false;installDialogs();installPageControl();openNativeIfPending();finishNativeSave();}
function queueScan(){if(scanQueued)return;scanQueued=true;requestAnimationFrame(scan);}
function init(){
  readCfg(function(c){
    currentCfg=c&&c.mode?c:{mode:"local"};
    if(window.sshRemote&&window.sshRemote.listHosts){
      try{window.sshRemote.listHosts().then(function(hosts){knownHosts=hosts||[];}).catch(function(){});}catch(e){}
    }
    scan();
    new MutationObserver(queueScan).observe(document.documentElement,{childList:true,subtree:true});
  });
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
${RENDERER_END}
`;

// ─── Layer 3: preload bridge ─────────────────────────────────────────────────
//
// contextIsolation is on, so the renderer can't touch ipcRenderer directly.
// Expose a minimal window.sshRemote bridge from the preload script.

const PRELOAD_START = ";/*__SSH_REMOTE_PRELOAD_START__*/";
const PRELOAD_END = "/*__SSH_REMOTE_PRELOAD_END__*/;";
const PRELOAD_INJECT = `
${PRELOAD_START}
;(function(){
try{
  var __e=require("electron");
  if(__e&&__e.contextBridge&&__e.ipcRenderer){
    __e.contextBridge.exposeInMainWorld("sshRemote",{
      read:function(){return __e.ipcRenderer.invoke("ssh-remote:read");},
      write:function(c){return __e.ipcRenderer.invoke("ssh-remote:write",c);},
      listHosts:function(){return __e.ipcRenderer.invoke("ssh-remote:list-hosts");},
      restart:function(){return __e.ipcRenderer.invoke("ssh-remote:restart");}
    });
  }
}catch(e){}
})();
${PRELOAD_END}
`;

function patchPreload(opts) {
  const bundles = locateBundles({ dir: "build", pattern: /^preload\.js$/, ...opts });
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    if (code.includes(PRELOAD_START)) {
      console.log(`  [ok] ${relPath(bundle.path)}: preload bridge already present`);
      patched++;
      continue;
    }
    let newCode = code;
    const oldStart = newCode.indexOf(';(function(){\ntry{\n  var __e=require("electron");\n  if(__e&&__e.contextBridge&&__e.ipcRenderer){\n    __e.contextBridge.exposeInMainWorld("sshRemote"');
    if (oldStart >= 0) {
      const oldEndMarker = "\n})();";
      const oldEnd = newCode.indexOf(oldEndMarker, oldStart);
      if (oldEnd < 0) {
        console.log(`  [!] ${relPath(bundle.path)}: old preload block end marker not found`);
        continue;
      }
      newCode = newCode.slice(0, oldStart) + PRELOAD_INJECT.trimStart() + newCode.slice(oldEnd + oldEndMarker.length);
    } else {
      newCode += PRELOAD_INJECT;
    }
    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: window.sshRemote bridge exposed`);
    patched++;
  }
  return patched;
}

// Find the renderer entry bundle and inject the modal
function patchRenderer(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes(RENDERER_START)) {
      const oldStart = code.indexOf(RENDERER_START);
      const oldEnd = code.indexOf(RENDERER_END, oldStart);
      if (oldEnd < 0) {
        console.log(`  [!] ${relPath(bundle.path)}: existing renderer block end marker not found`);
        continue;
      }
      const end = oldEnd + RENDERER_END.length;
      const replacement = RENDERER_INJECT.trim();
      if (code.slice(oldStart, end) !== replacement) {
        fs.writeFileSync(bundle.path, code.slice(0, oldStart) + replacement + code.slice(end));
        console.log(`  [ok] ${relPath(bundle.path)}: renderer integration updated`);
      } else {
        console.log(`  [ok] ${relPath(bundle.path)}: renderer already patched`);
      }
      patched++;
      continue;
    }

    let newCode = code;
    const oldStart = newCode.indexOf(';(function(){\nif(window.__sshRemoteUiInstalled)return;');
    if (oldStart >= 0) {
      const oldEndMarker = 'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);\nelse init();\n})();';
      const oldEnd = newCode.indexOf(oldEndMarker, oldStart);
      if (oldEnd < 0) {
        console.log(`  [!] ${relPath(bundle.path)}: old renderer block end marker not found`);
        continue;
      }
      newCode = newCode.slice(0, oldStart) + RENDERER_INJECT.trimStart() + newCode.slice(oldEnd + oldEndMarker.length);
    } else {
      newCode += RENDERER_INJECT;
    }
    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: native Connections integration injected`);
    patched++;
  }
  return patched;
}

// ─── Layer 1b: ipcMain handler injection ────────────────────────────────────
//
// Injects ipcMain.handle("ssh-remote:read") and ("ssh-remote:write") into the
// app-main bundle so the renderer can persist config to userData.

const IPC_START = ";/*__SSH_REMOTE_IPC_START__*/";
const IPC_END = "/*__SSH_REMOTE_IPC_END__*/;";
const IPC_INJECT = `
${IPC_START}
;(function(){
// Injected into every main-process chunk (spawn intercept needs all chunks
// scanned), but ipcMain.handle throws on a duplicate channel. Guard so only
var __electron=require("electron");
// the first compatible chunk to execute registers the handlers.
if(!__electron||!__electron.ipcMain)return;
if(global.__sshRemoteIpcRegistered)return;
global.__sshRemoteIpcRegistered=true;
var __fs=require("fs");
var __path=require("path");
var __os=require("os");
var __safe=null;
try{__safe=__electron.safeStorage;}catch(e){}
function __sshCfgPath(){
  return __path.join(__electron.app.getPath("userData"),"ssh-remote.json");
}
// Parse ~/.ssh/config into host entries. Skips wildcard patterns (Host *).
function __parseSshConfig(text){
  var lines=String(text||"").split(/\\r?\\n/),hosts=[],cur=null;
  for(var i=0;i<lines.length;i++){
    var line=lines[i].replace(/#.*$/,"").trim();
    if(!line)continue;
    var sp=line.match(/^(\\S+)[\\s=]+(.*)$/);if(!sp)continue;
    var key=sp[1].toLowerCase(),val=sp[2].trim();
    if(key==="host"){
      var aliases=val.split(/\\s+/).filter(function(a){return a&&a.indexOf("*")<0&&a.indexOf("?")<0;});
      if(aliases.length){cur={alias:aliases[0],aliases:aliases,hostName:"",user:"",identityFile:"",proxyCommand:"",proxyJump:"",port:""};hosts.push(cur);}
      else cur=null;
    }else if(cur){
      if(key==="hostname")cur.hostName=val;
      else if(key==="user")cur.user=val;
      else if(key==="identityfile")cur.identityFile=val;
      else if(key==="proxycommand")cur.proxyCommand=val;
      else if(key==="proxyjump")cur.proxyJump=val;
      else if(key==="port")cur.port=val;
    }
  }
  return hosts;
}
__electron.ipcMain.handle("ssh-remote:read",function(){
  try{
    var p=__sshCfgPath();if(!__fs.existsSync(p))return null;
    var cfg=JSON.parse(__fs.readFileSync(p,"utf8"));
    cfg.hasPassword=!!cfg.passwordEncrypted;
    delete cfg.passwordEncrypted;delete cfg.password;
    return cfg;
  }catch(e){throw new Error("Failed to read SSH configuration: "+e.message);}
});
__electron.ipcMain.handle("ssh-remote:write",function(_e,cfg){
  if(!cfg||!['local','fully-remote'].includes(cfg.mode))throw new Error("Invalid connection mode");
  if(cfg.mode==="fully-remote"&&!String(cfg.host||"").trim())throw new Error("Remote host is required");
  if(cfg.port!=null&&(!Number.isInteger(cfg.port)||cfg.port<1||cfg.port>65535))throw new Error("Port must be between 1 and 65535");
  var p=__sshCfgPath(),previous={};
  try{if(__fs.existsSync(p))previous=JSON.parse(__fs.readFileSync(p,"utf8"));}catch(e){}
  var stored=Object.assign({},cfg);delete stored.hasPassword;delete stored.keepPassword;
  if(stored.password){
    if(!__safe||!__safe.isEncryptionAvailable())throw new Error("Secure password storage is unavailable; use an SSH key or agent");
    stored.passwordEncrypted=__safe.encryptString(String(stored.password)).toString("base64");
  }else if(cfg.keepPassword&&previous.passwordEncrypted){stored.passwordEncrypted=previous.passwordEncrypted;}
  delete stored.password;
  try{
    __fs.mkdirSync(__path.dirname(p),{recursive:true});
    var tmp=p+".tmp";__fs.writeFileSync(tmp,JSON.stringify(stored,null,2),{encoding:"utf8",mode:0o600});
    __fs.renameSync(tmp,p);return {ok:true};
  }catch(e){throw new Error("Failed to save SSH configuration: "+e.message);}
});
__electron.ipcMain.handle("ssh-remote:list-hosts",function(){
  try{
    var p=__path.join(__os.homedir(),".ssh","config");
    if(!__fs.existsSync(p))return [];
    return __parseSshConfig(__fs.readFileSync(p,"utf8"));
  }catch(e){return [];}
});
__electron.ipcMain.handle("ssh-remote:restart",function(){
  setTimeout(function(){__electron.app.relaunch();__electron.app.exit(0);},150);
  return {ok:true};
});
})();
${IPC_END}
`;

function patchAppMainIpc(bundles) {
  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");
    if (code.includes(IPC_START)) {
      const oldStart = code.indexOf(IPC_START);
      const oldEnd = code.indexOf(IPC_END, oldStart);
      if (oldEnd < 0) {
        console.log(`  [!] ${relPath(bundle.path)}: existing IPC block end marker not found`);
        continue;
      }
      const end = oldEnd + IPC_END.length;
      const replacement = IPC_INJECT.trim();
      if (code.slice(oldStart, end) !== replacement) {
        fs.writeFileSync(bundle.path, code.slice(0, oldStart) + replacement + code.slice(end));
        console.log(`  [ok] ${relPath(bundle.path)}: ipc handlers updated`);
      } else {
        console.log(`  [ok] ${relPath(bundle.path)}: ipc already patched`);
      }
      patched++;
      continue;
    }
    let newCode = code;
    const oldStart = newCode.indexOf(';(function(){\n// Injected into every main-process chunk');
    if (oldStart >= 0) {
      const oldEndMarker = "\n})();";
      const oldEnd = newCode.indexOf(oldEndMarker, oldStart);
      if (oldEnd < 0) {
        console.log(`  [!] ${relPath(bundle.path)}: old IPC block end marker not found`);
        continue;
      }
      newCode = newCode.slice(0, oldStart) + IPC_INJECT.trimStart() + newCode.slice(oldEnd + oldEndMarker.length);
    } else {
      newCode += IPC_INJECT;
    }
    fs.writeFileSync(bundle.path, newCode);
    console.log(`  [ok] ${relPath(bundle.path)}: ipc handlers injected`);
    patched++;
  }
  return patched;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );
  const opts = platform ? { platform } : {};

  console.log("  [layer 1a] app-main: SSH spawn intercept");
  // Scan ALL main-*/src-* chunks: upstream minification splits the
  // spawnProcess() class into a hashed chunk that isn't the "primary" one,
  // so a single-file lookup can miss it entirely.
  const appMainBundles = [
    ...locateBundles({ dir: "build", pattern: /^main-.*\.js$/, all: true, ...opts }),
    ...locateBundles({ dir: "build", pattern: /^src-.*\.js$/, all: true, ...opts }),
  ];
  const spawnPatched = patchAppMain(appMainBundles);

  console.log("  [layer 1b] app-main: ipcMain ssh-remote handlers");
  const ipcPatched = patchAppMainIpc(appMainBundles);

  console.log("  [layer 2] renderer: native Connections mode selector");
  const rendererBundles = locateRendererEntry(opts);
  const rendererPatched = patchRenderer(rendererBundles);

  console.log("  [layer 3] preload: window.sshRemote bridge");
  const preloadPatched = patchPreload(opts);

  console.log(`  [done] spawn:${spawnPatched} ipc:${ipcPatched} renderer:${rendererPatched} preload:${preloadPatched}`);

  // The spawn intercept is the whole point of Fully-Remote mode. If it didn't
  // land, the feature is silently dead — fail so patch-all surfaces it.
  if (spawnPatched === 0) {
    console.error("  [x] SSH spawn intercept matched 0 bundles — upstream layout changed");
    process.exit(1);
  }
  // The mode selector is useless without the preload bridge — fail loudly.
  if (preloadPatched === 0) {
    console.error("  [x] preload bridge matched 0 bundles — renderer UI can't reach main");
    process.exit(1);
  }
  // No renderer entry patched → the mode selector never renders.
  if (rendererPatched === 0) {
    console.error("  [x] renderer entry matched 0 bundles — mode selector won't render");
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  IPC_INJECT,
  PRELOAD_INJECT,
  RENDERER_INJECT,
  SSH_HELPER,
  patchAppMain,
  patchAppMainIpc,
  patchRenderer,
};
