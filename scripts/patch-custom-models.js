#!/usr/bin/env node
/**
 * patch-custom-models.js — Fetch the model list from the configured API source
 * (/v1/models) instead of relying on the preset model candidates.
 *
 * The picker sources models from the app-server RPC `list-models-for-host`,
 * whose result is an array of objects shaped like
 *   { model, displayName, hidden, isDefault, supportedReasoningEfforts:[{reasoningEffort,description}] }
 * (see model-list-filter). We add:
 *   - main-process IPC that reads base_url from ~/.codex/config.toml + key from
 *     ~/.codex/auth.json, GETs {base}/v1/models, and stores the list in that shape.
 *   - a window.codexModels preload bridge.
 *   - a queryFn override so the picker uses the custom list when present.
 *   - a floating "⟳ Models" button + panel to fetch / clear.
 *
 * Usage: node scripts/patch-custom-models.js [mac-arm64|mac-x64|win]
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

// Resolve the renderer entry bundle from index.html (only that one executes).
function locateRendererEntry(opts) {
  const platforms = opts.platform ? [opts.platform] : ["mac-arm64", "mac-x64", "win"];
  const results = [];
  for (const plat of platforms) {
    const webviewDir = path.join(SRC_DIR, plat, "_asar", "webview");
    const indexHtml = path.join(webviewDir, "index.html");
    if (!fs.existsSync(indexHtml)) continue;
    const html = fs.readFileSync(indexHtml, "utf-8");
    const m = html.match(/src="\.?\/?assets\/(index-[A-Za-z0-9_-]+\.js)"/);
    if (!m) continue;
    const entry = path.join(webviewDir, "assets", m[1]);
    if (fs.existsSync(entry)) results.push({ platform: plat, path: entry });
  }
  return results;
}

function replaceInjectedIife(code, sentinel, injection) {
  const marker = code.indexOf(sentinel);
  if (marker < 0) return null;
  const start = code.lastIndexOf(";(function(){", marker);
  const end = code.indexOf("\n})();", marker);
  if (start < 0 || end < 0) return null;
  return code.slice(0, start) + injection + code.slice(end + "\n})();".length);
}

// ─── Layer 1: main-process IPC ───────────────────────────────────────────────
const IPC_INJECT = `
;(function(){
if(global.__codexModelsIpcRegistered)return;
global.__codexModelsIpcRegistered=true;
var __e=require("electron"),__fs=require("fs"),__path=require("path"),__os=require("os"),__cp=require("child_process");
if(!__e||!__e.ipcMain)return;
function __cmFile(){return __path.join(__e.app.getPath("userData"),"codex-custom-models.json");}
function __cmModelObj(id,def){
  return {model:id,displayName:id,hidden:false,isDefault:id===def,
    supportedReasoningEfforts:[
      {reasoningEffort:"low",description:"Fast responses with lighter reasoning"},
      {reasoningEffort:"medium",description:"Balances speed and reasoning depth for everyday tasks"},
      {reasoningEffort:"high",description:"Greater reasoning depth for complex problems"},
      {reasoningEffort:"xhigh",description:"Extra high reasoning depth for complex problems"}
    ]};
}
// Claude Code model list — fetched from the Anthropic-compatible endpoint the
// machine's claude actually uses (ANTHROPIC_BASE_URL + token), so it's real and
// complete (opus 4.6/4.7/4.8, sonnet 5/4.6, haiku, fable…). Cached in-process.
function __claudeFallback(){
  return ["claude-opus-4-8","claude-opus-4-7","claude-opus-4-6","claude-sonnet-5","claude-sonnet-4-6","claude-haiku-4-5","claude-fable-5"].map(function(id){return {id:id,display_name:"Claude "+id.replace(/^claude-/,"")};});
}
function __anthToken(){
  var t=process.env.ANTHROPIC_AUTH_TOKEN||process.env.ANTHROPIC_API_KEY||"";
  if(!t){try{var cr=JSON.parse(__fs.readFileSync(__path.join(__os.homedir(),".claude",".credentials.json"),"utf8"));t=(cr.claudeAiOauth&&cr.claudeAiOauth.accessToken)||cr.accessToken||"";}catch(e){}}
  return t;
}
async function __fetchClaudeModels(){
  try{
    var base=(process.env.ANTHROPIC_BASE_URL||"https://api.anthropic.com").replace(/\\/$/,"");
    var tok=__anthToken();
    var r=await fetch(base+"/v1/models?limit=100",{headers:{"x-api-key":tok,"authorization":"Bearer "+tok,"anthropic-version":"2023-06-01"}});
    if(!r.ok)return null;
    var j=await r.json();var arr=j.data||j.models||[];
    var cl=arr.map(function(m){return {id:m.id||m.name,display_name:m.display_name||m.id};}).filter(function(m){return m.id&&/claude/i.test(m.id);});
    return cl.length?cl:null;
  }catch(e){return null;}
}
var __claudeCache=null;
__e.ipcMain.handle("claude-models:get",async function(){
  if(__claudeCache)return __claudeCache;
  var live=await __fetchClaudeModels();
  __claudeCache=live||__claudeFallback();
  return __claudeCache;
});
__e.ipcMain.handle("claude-models:refresh",async function(){
  var live=await __fetchClaudeModels();
  if(live)__claudeCache=live;
  return {ok:!!live,count:(__claudeCache||[]).length,fetched:!!live};
});
__e.ipcMain.handle("codex-models:get",function(){
  try{var p=__cmFile();return __fs.existsSync(p)?JSON.parse(__fs.readFileSync(p,"utf8")):null;}catch(e){return null;}
});
__e.ipcMain.handle("codex-models:clear",function(){
  try{var p=__cmFile();if(__fs.existsSync(p))__fs.unlinkSync(p);return {ok:true};}catch(e){return {ok:false,error:String(e)};}
});
// Feature B: scaffold/model/host backend selection (read by the cc-bridge).
function __ccBackendFile(){return __path.join(__os.homedir(),".codex","cc-bridge","backend");}
function __readBackend(){
  try{var p=__ccBackendFile();if(!__fs.existsSync(p))return {scaffold:"codex"};var raw=__fs.readFileSync(p,"utf8").trim();if(raw.charAt(0)==="{")return JSON.parse(raw);return {scaffold:/claude/i.test(raw)?"claude":"codex"};}catch(e){return {scaffold:"codex"};}
}
__e.ipcMain.handle("codex-backend:get",function(){
  return __readBackend();
});
__e.ipcMain.handle("codex-backend:set",function(_e,cfg){
  try{var dir=__path.join(__os.homedir(),".codex","cc-bridge");__fs.mkdirSync(dir,{recursive:true});
    if(!cfg||cfg.scaffold!=="claude")__fs.writeFileSync(__ccBackendFile(),"codex");
    else __fs.writeFileSync(__ccBackendFile(),JSON.stringify({scaffold:"claude",model:cfg.model||undefined,host:cfg.host||undefined,port:cfg.port||undefined,password:cfg.password||undefined,token:cfg.token||undefined}));
    return {ok:true};}catch(e){return {ok:false,error:String(e)};}
});
__e.ipcMain.handle("codex-models:set",function(_e,list){
  try{__fs.writeFileSync(__cmFile(),JSON.stringify(list,null,2));return {ok:true};}catch(e){return {ok:false,error:String(e)};}
});
function __probeCommand(command,args,opts){
  return new Promise(function(resolve){
    var out="",err="",done=false;
    function finish(ok,message){if(done)return;done=true;resolve({ok:ok,message:message,output:(out+"\\n"+err).trim().slice(-1200)});}
    var child;
    try{child=__cp.spawn(command,args,opts);}catch(e){finish(false,String(e&&e.message||e));return;}
    var timer=setTimeout(function(){try{child.kill();}catch(e){}finish(false,"Timed out after 60 seconds");},60000);
    if(child.stdout)child.stdout.on("data",function(d){out+=d.toString("utf8");if(out.length>16000)out=out.slice(-8000);});
    if(child.stderr)child.stderr.on("data",function(d){err+=d.toString("utf8");if(err.length>16000)err=err.slice(-8000);});
    try{if(child.stdin)child.stdin.end();}catch(e){}
    child.on("error",function(e){clearTimeout(timer);finish(false,String(e&&e.message||e));});
    child.on("close",function(code){clearTimeout(timer);var all=(out+"\\n"+err).trim();finish(code===0,code===0?"Harness responded successfully":("Harness exited with code "+code+(all?": "+all.slice(-300):"")));});
  });
}
__e.ipcMain.handle("codex-models:test",async function(_e,spec){
  try{
    spec=spec||{};var harness=spec.harness==="claude"||spec.harness==="claude_code"?"claude":"codex";
    var model=String(spec.model||"").trim();
    if(!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/.test(model))return {ok:false,message:"Model ID contains unsupported characters"};
    var cfg=__readBackend(),cwd=__os.homedir(),prompt="Reply with exactly OK.";
    if(harness==="codex"){
      var codex=process.env.CODEX_CLI_PATH||__path.join(process.resourcesPath||"","codex.exe");
      if(!__fs.existsSync(codex))codex=process.platform==="win32"?"codex.cmd":"codex";
      return await __probeCommand(codex,["exec","--json","--ephemeral","--skip-git-repo-check","-m",model,prompt],{cwd:cwd,windowsHide:true,shell:process.platform==="win32"&&!__fs.existsSync(codex),env:process.env});
    }
    var args=["-p","--output-format","json","--no-session-persistence","--model",model,prompt],command=process.platform==="win32"?"claude.cmd":"claude",shell=process.platform==="win32",env=Object.assign({},process.env);
    if(cfg.host){
      if(!/^[A-Za-z0-9_.@:-]+$/.test(String(cfg.host)))return {ok:false,message:"Remote host contains unsupported characters"};
      command="ssh";shell=false;var ssh=["-T","-o","StrictHostKeyChecking=accept-new"];
      if(cfg.port)ssh.push("-p",String(cfg.port));
      var remotePrefix=[];if(cfg.token)remotePrefix.push((/^sk-ant-api/.test(cfg.token)?"ANTHROPIC_API_KEY=":"CLAUDE_CODE_OAUTH_TOKEN=")+cfg.token);
      args=ssh.concat([cfg.host]).concat(remotePrefix).concat([cfg.remoteClaude||"claude"]).concat(args);
    }
    return await __probeCommand(command,args,{cwd:cwd,windowsHide:true,shell:shell,env:env});
  }catch(e){return {ok:false,message:String(e&&e.message||e)};}
});
__e.ipcMain.handle("codex-models:fetch",async function(){
  try{
    var home=__os.homedir();
    var cfg=__fs.readFileSync(__path.join(home,".codex","config.toml"),"utf8");
    var prov=(cfg.match(/^\\s*model_provider\\s*=\\s*"([^"]+)"/m)||[])[1]||"OpenAI";
    // line-based TOML scan for base_url under [model_providers.<prov>]
    var lines=cfg.split(/\\r?\\n/),curSec="",base=null,wantSec="[model_providers."+prov+"]";
    for(var i=0;i<lines.length;i++){
      var ln=lines[i].trim();
      if(ln.charAt(0)==="["){curSec=ln;continue;}
      if(curSec===wantSec){var mm=ln.match(/^base_url\\s*=\\s*"([^"]+)"/);if(mm){base=mm[1];break;}}
    }
    if(!base){var g=cfg.match(/base_url\\s*=\\s*"([^"]+)"/);if(g)base=g[1];}
    var def=(cfg.match(/^\\s*model\\s*=\\s*"([^"]+)"/m)||[])[1]||null;
    if(!base)return {ok:false,error:"no base_url in ~/.codex/config.toml"};
    var auth={};try{auth=JSON.parse(__fs.readFileSync(__path.join(home,".codex","auth.json"),"utf8"));}catch(e){}
    var key=auth.OPENAI_API_KEY||auth.openai_api_key||auth.api_key||"";
    var url=base.replace(/\\/$/,"")+"/v1/models";
    var r=await fetch(url,{headers:key?{Authorization:"Bearer "+key}:{}});
    if(!r.ok)return {ok:false,error:"HTTP "+r.status+" from "+url};
    var j=await r.json();
    var arr=j.data||j.models||j||[];
    var skip=/image|audio|realtime|embedding|tts|whisper|dall-?e|moderation|transcribe|speech|video/i;
    var ids=arr.map(function(m){return typeof m==="string"?m:(m&&(m.id||m.name));}).filter(Boolean).filter(function(id){return !skip.test(id);});
    // Feed the app's NATIVE picker one unified list: codex models from the API +
    // Claude Code models. Real model ids (no prefix) so the picker renders them
    // normally; the cc-bridge routes by name (claude-* / opus / sonnet / haiku →
    // Claude Code, else codex). Display names are tagged so you can tell them apart.
    // Unified list for the (now list-based) native picker: codex from the API +
    // Claude Code models. Real ids so the bridge routes by name; displayName tags
    // the harness so they're easy to tell apart in the list.
    var CLAUDE=(await __fetchClaudeModels())||__claudeFallback();
    var models=ids.map(function(id){return __cmModelObj(id,def);});   // codex: plain (native picker)
    CLAUDE.forEach(function(m){var o=__cmModelObj(m.id,null);o.displayName=m.display_name||("claude · "+m.id);models.push(o);});
    __fs.writeFileSync(__cmFile(),JSON.stringify(models,null,2));
    return {ok:true,count:models.length,codex:ids.length,claude:CLAUDE.length,base:base,models:models.map(function(m){return m.model;})};
  }catch(e){return {ok:false,error:String(e&&e.message||e)};}
});
})();
`;

function patchIpc(bundles) {
  let patched = 0;
  for (const b of bundles) {
    const code = fs.readFileSync(b.path, "utf-8");
    const refreshed = replaceInjectedIife(code, "if(global.__codexModelsIpcRegistered)return;", IPC_INJECT);
    fs.writeFileSync(b.path, refreshed == null ? code + IPC_INJECT : refreshed);
    console.log(`  [ok] ${relPath(b.path)}: codex-models ipc ${refreshed == null ? "injected" : "refreshed"}`);
    patched++;
  }
  return patched;
}

// ─── Layer 2: preload bridge ─────────────────────────────────────────────────
const PRELOAD_INJECT = `
;(function(){
try{
  var __e=require("electron");
  if(__e&&__e.contextBridge&&__e.ipcRenderer){
    __e.contextBridge.exposeInMainWorld("codexModels",{
      fetch:function(){return __e.ipcRenderer.invoke("codex-models:fetch");},
      get:function(){return __e.ipcRenderer.invoke("codex-models:get");},
      set:function(list){return __e.ipcRenderer.invoke("codex-models:set",list);},
      getClaude:function(){return __e.ipcRenderer.invoke("claude-models:get");},
      refreshClaude:function(){return __e.ipcRenderer.invoke("claude-models:refresh");},
      test:function(spec){return __e.ipcRenderer.invoke("codex-models:test",spec);},
      clear:function(){return __e.ipcRenderer.invoke("codex-models:clear");},
      getBackend:function(){return __e.ipcRenderer.invoke("codex-backend:get");},
      setBackend:function(c){return __e.ipcRenderer.invoke("codex-backend:set",c);}
    });
  }
}catch(e){}
})();
`;

function patchPreload(opts) {
  const bundles = locateBundles({ dir: "build", pattern: /^preload\.js$/, ...opts });
  let patched = 0;
  for (const b of bundles) {
    const code = fs.readFileSync(b.path, "utf-8");
    const refreshed = replaceInjectedIife(code, 'exposeInMainWorld("codexModels"', PRELOAD_INJECT);
    fs.writeFileSync(b.path, refreshed == null ? code + PRELOAD_INJECT : refreshed);
    console.log(`  [ok] ${relPath(b.path)}: window.codexModels bridge ${refreshed == null ? "exposed" : "refreshed"}`);
    patched++;
  }
  return patched;
}

// ─── Layer 3: model-queries override ─────────────────────────────────────────
function patchModelQueries(opts) {
  const bundles = locateBundles({ dir: "assets", pattern: /^model-queries-.*\.js$/, ...opts });
  const oldLabel = "__a=__a.map(function(x){var isC=/^(claude|opus|sonnet|haiku|fable)/i.test(x.model);var hn=isC?`claude_code`:`codex`;var sh=x.model.replace(/^claude-/,``);return Object.assign({},x,{displayName:`[`+hn+`]-`+sh});});";
  const newLabel = "__a=__a.map(function(x){var mt=/^\\[(codex|claude_code|claude)\\]-(.+)$/.exec(x.model);var isC=mt?mt[1]!==`codex`:/^(claude|opus|sonnet|haiku|fable)/i.test(x.model);var hn=isC?`claude_code`:`codex`;var sh=mt?mt[2]:x.model.replace(/^claude-/,``);return Object.assign({},x,{displayName:`[`+hn+`]-`+sh});});";
  let patched = 0;
  for (const b of bundles) {
    let code = fs.readFileSync(b.path, "utf-8");
    if (code.includes("window.codexModels")) {
      if (code.includes(oldLabel)) {
        code = code.replace(oldLabel, newLabel);
        fs.writeFileSync(b.path, code);
        console.log(`  [ok] ${relPath(b.path)}: model-queries labels refreshed`);
      } else {
        console.log(`  [ok] ${relPath(b.path)}: model-queries already patched`);
      }
      patched++;
      continue;
    }
    const re = /queryFn:\(\)=>(\w+)\(`list-models-for-host`,(\{[^}]*\})\)/;
    const m = code.match(re);
    if (!m) {
      console.log(`  [!] ${relPath(b.path)}: list-models-for-host queryFn not found`);
      continue;
    }
    // Always merge the Claude Code models into whatever list the picker gets
    // (custom API list OR the native codex presets) so they show in the native
    // menu with zero setup. The cc-bridge routes by model name at turn time.
    const repl =
      "queryFn:async()=>{" +
      "var __eff=[{reasoningEffort:`low`,description:`Fast responses with lighter reasoning`}," +
      "{reasoningEffort:`medium`,description:`Balances speed and reasoning depth for everyday tasks`}," +
      "{reasoningEffort:`high`,description:`Greater reasoning depth for complex problems`}," +
      "{reasoningEffort:`xhigh`,description:`Extra high reasoning depth for complex problems`}];" +
      "var __cl=[];try{var __cg=window.codexModels&&window.codexModels.getClaude&&await window.codexModels.getClaude();" +
      "if(__cg&&__cg.length)__cl=__cg.map(function(x){return{model:x.id,displayName:x.display_name||(`claude · `+x.id),hidden:false,isDefault:false,supportedReasoningEfforts:__eff};});}catch(e){}" +
      "if(!__cl.length)__cl=[`claude-opus-4-8`,`claude-opus-4-7`,`claude-opus-4-6`,`claude-sonnet-5`,`claude-sonnet-4-6`,`claude-haiku-4-5`,`claude-fable-5`].map(function(x){return{model:x,displayName:`claude · `+x,hidden:false,isDefault:false,supportedReasoningEfforts:__eff};});" +
      "var __r;try{var __cm=window.codexModels&&await window.codexModels.get();" +
      "if(__cm&&__cm.length)__r={data:__cm};}catch(e){}" +
      "if(!__r)__r=await " + m[1] + "(`list-models-for-host`," + m[2] + ");" +
      "try{var __a=(__r&&__r.data)?__r.data.slice():[];var __h=new Set(__a.map(function(m){return m.model;}));" +
      "__cl.forEach(function(c){if(!__h.has(c.model))__a.push(c);});" +
      // Label every entry [harness]-[model] (id stays real for routing/rendering).
      newLabel +
      "__r=Object.assign({},__r,{data:__a});}catch(e){}" +
      "return __r}";
    code = code.replace(re, repl);
    fs.writeFileSync(b.path, code);
    console.log(`  [ok] ${relPath(b.path)}: queryFn override injected`);
    patched++;
  }
  return patched;
}

// ─── Layer 4: renderer floating panel ────────────────────────────────────────
const UI_INJECT = `
;(function(){
if(window.__codexModelsUiInstalled)return;
window.__codexModelsUiInstalled=true;
var FONT="system-ui,-apple-system,Segoe UI,sans-serif";
function el(t,s,x){var n=document.createElement(t);if(s)for(var k in s)n.style[k]=s[k];if(x!=null)n.textContent=x;return n;}
function modelEfforts(){return[
  {reasoningEffort:"low",description:"Fast responses with lighter reasoning"},
  {reasoningEffort:"medium",description:"Balances speed and reasoning depth"},
  {reasoningEffort:"high",description:"Greater reasoning depth for complex problems"},
  {reasoningEffort:"xhigh",description:"Extra high reasoning depth"}
];}
function openPanel(){
  var old=document.getElementById("__cm-panel");if(old){old.remove();return;}
  var box=el("div",{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",zIndex:"2147483646",width:"380px",maxWidth:"calc(100vw - 32px)",maxHeight:"min(720px,calc(100vh - 32px))",overflowY:"auto",background:"#1e1e1e",color:"#e0e0e0",border:"1px solid #444",borderRadius:"8px",padding:"16px",boxShadow:"0 12px 36px rgba(0,0,0,0.65)",fontFamily:FONT,fontSize:"13px"});
  box.id="__cm-panel";
  var heading=el("div",{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"12px"});
  heading.appendChild(el("div",{fontSize:"15px",fontWeight:"600"},"Add custom model"));
  var closeBtn=el("button",{width:"28px",height:"28px",border:"none",background:"transparent",color:"#aaa",fontSize:"20px",lineHeight:"24px",cursor:"pointer"},"\u00d7");
  closeBtn.type="button";closeBtn.title="Close";closeBtn.setAttribute("aria-label","Close");closeBtn.onclick=function(){box.remove();};heading.appendChild(closeBtn);box.appendChild(heading);
  var addWrap=el("div",{paddingBottom:"14px",marginBottom:"14px",borderBottom:"1px solid #3a3a3a"});
  addWrap.appendChild(el("div",{fontSize:"11px",color:"#999",marginBottom:"5px"},"Harness"));
  var harness="codex",harnessRow=el("div",{display:"flex",gap:"6px",marginBottom:"10px"});
  function harnessButton(value,label){
    var button=el("button",{flex:"1",padding:"8px",borderRadius:"6px",border:"1px solid #555",background:"#2a2a2a",color:"#ddd",cursor:"pointer",fontSize:"12px"},label);
    button.type="button";button.onclick=function(){harness=value;Array.prototype.forEach.call(harnessRow.children,function(b){b.style.background="#2a2a2a";b.style.borderColor="#555";});button.style.background="#2d2060";button.style.borderColor="#7c6af7";};return button;
  }
  var hc=harnessButton("codex","Codex"),hh=harnessButton("claude","Claude Code");harnessRow.appendChild(hc);harnessRow.appendChild(hh);addWrap.appendChild(harnessRow);hc.click();
  addWrap.appendChild(el("div",{fontSize:"11px",color:"#999",marginBottom:"5px"},"Model ID"));
  var customModel=el("input",{width:"100%",boxSizing:"border-box",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"8px 9px",color:"#e0e0e0",fontSize:"12px",marginBottom:"8px"});
  customModel.placeholder="gpt-5.6 or claude-opus-4-8";customModel.autocomplete="off";addWrap.appendChild(customModel);
  var customStatus=el("div",{minHeight:"18px",fontSize:"11px",color:"#999",lineHeight:"1.45",whiteSpace:"pre-wrap",overflowWrap:"anywhere",marginBottom:"8px"});addWrap.appendChild(customStatus);
  var customActions=el("div",{display:"flex",gap:"8px"});
  var testBtn=el("button",{padding:"8px 12px",borderRadius:"6px",border:"1px solid #555",background:"#2a2a2a",color:"#e0e0e0",cursor:"pointer",fontWeight:"600"},"Test");
  testBtn.type="button";testBtn.onclick=function(){
    var model=customModel.value.trim();if(!model){customStatus.textContent="Enter a model ID.";return;}if(!(window.codexModels&&window.codexModels.test)){customStatus.textContent="Test bridge unavailable.";return;}
    testBtn.disabled=true;testBtn.textContent="Testing...";customStatus.style.color="#999";customStatus.textContent="Running a one-prompt harness test...";
    window.codexModels.test({harness:harness,model:model}).then(function(r){customStatus.style.color=r&&r.ok?"#75b798":"#e38b8b";customStatus.textContent=(r&&r.message)||"Test failed";if(r&&r.output)customStatus.textContent+="\\n"+r.output.slice(-320);}).catch(function(e){customStatus.style.color="#e38b8b";customStatus.textContent=String(e&&e.message||e);}).then(function(){testBtn.disabled=false;testBtn.textContent="Test";});
  };
  customActions.appendChild(testBtn);
  var addModelBtn=el("button",{flex:"1",padding:"8px 12px",borderRadius:"6px",border:"none",background:"#7c6af7",color:"#fff",cursor:"pointer",fontWeight:"600"},"Add and select");
  addModelBtn.type="button";addModelBtn.onclick=function(){
    var model=customModel.value.trim();if(!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/.test(model)){customStatus.style.color="#e38b8b";customStatus.textContent="Use letters, numbers, dot, dash, underscore, colon, or slash.";return;}
    if(!window.codexModels){customStatus.textContent="Model bridge unavailable.";return;}
    var tag="["+(harness==="claude"?"claude_code":"codex")+"]-"+model;
    addModelBtn.disabled=true;customStatus.style.color="#999";customStatus.textContent="Saving...";
    window.codexModels.get().then(function(saved){
      var list=saved&&saved.length?saved.slice():Array.prototype.slice.call(window.__ccMenuModels||[]);
      list=list.filter(function(x){return x&&x.model!==tag;});
      list.push({model:tag,displayName:tag,hidden:false,isDefault:false,defaultReasoningEffort:"medium",supportedReasoningEfforts:modelEfforts()});
      return window.codexModels.set(list);
    }).then(function(r){if(!r||!r.ok)throw Error(r&&r.error||"Could not save model");return window.codexModels.setBackend({scaffold:harness,model:model});}).then(function(r){
      if(!r||!r.ok)throw Error(r&&r.error||"Could not select harness");
      if(typeof window.__ccSelectModel==="function")window.__ccSelectModel(tag,"medium");
      customStatus.style.color="#75b798";customStatus.textContent="Added and selected: "+tag;refresh();
    }).catch(function(e){customStatus.style.color="#e38b8b";customStatus.textContent=String(e&&e.message||e);}).then(function(){addModelBtn.disabled=false;});
  };
  customActions.appendChild(addModelBtn);addWrap.appendChild(customActions);box.appendChild(addWrap);
  box.appendChild(el("div",{fontSize:"13px",fontWeight:"600",marginBottom:"8px"},"Model sources"));
  var info=el("div",{fontSize:"12px",color:"#999",marginBottom:"10px",whiteSpace:"pre-wrap",lineHeight:"1.5"},"Fetch the model list from your API source (/v1/models) and use it in the picker instead of the presets.");
  box.appendChild(info);
  var list=el("div",{margin:"8px 0",fontSize:"12px",color:"#7a9a7a",whiteSpace:"pre-wrap",maxHeight:"220px",overflowY:"auto"});
  box.appendChild(list);
  function refresh(){ if(window.codexModels)window.codexModels.get().then(function(c){ list.textContent=c&&c.length?("Custom list ("+c.length+"):\\n"+c.map(function(m){return "\\u2022 "+m.model;}).join("\\n")):"(no custom list — using default presets)"; }); }
  refresh();
  var row=el("div",{display:"flex",gap:"8px",marginTop:"12px",flexWrap:"wrap"});
  var fetchBtn=el("button",{flex:"1",minWidth:"120px",padding:"8px",borderRadius:"6px",border:"none",background:"#7c6af7",color:"#fff",fontWeight:"600",cursor:"pointer"},"Fetch from API");
  fetchBtn.onclick=function(){
    if(!window.codexModels){info.textContent="bridge unavailable";return;}
    fetchBtn.disabled=true;fetchBtn.textContent="Fetching\\u2026";
    window.codexModels.fetch().then(function(r){
      if(r&&r.ok){info.textContent="Fetched "+r.count+" models from "+r.base+" ("+r.all+" total). Click Reload to apply.";refresh();}
      else{info.textContent="Error: "+((r&&r.error)||"unknown");}
      fetchBtn.disabled=false;fetchBtn.textContent="Fetch from API";
    });
  };
  row.appendChild(fetchBtn);
  var reloadBtn=el("button",{padding:"8px 12px",borderRadius:"6px",border:"1px solid #555",background:"#2a2a2a",color:"#e0e0e0",cursor:"pointer"},"Reload");
  reloadBtn.onclick=function(){location.reload();};
  row.appendChild(reloadBtn);
  var clearBtn=el("button",{padding:"8px 12px",borderRadius:"6px",border:"1px solid #555",background:"#2a2a2a",color:"#e0e0e0",cursor:"pointer"},"Use default");
  clearBtn.onclick=function(){ if(window.codexModels)window.codexModels.clear().then(function(){info.textContent="Cleared. Click Reload to use default presets.";refresh();}); };
  row.appendChild(clearBtn);
  box.appendChild(row);

  // ── Feature B: two-axis backend picker (scaffold x model, + remote host) ──
  function mkInput(parent,label,ph){
    parent.appendChild(el("div",{fontSize:"11px",color:"#999",margin:"6px 0 3px"},label));
    var inp=el("input",{width:"100%",boxSizing:"border-box",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"7px 9px",color:"#e0e0e0",fontSize:"12px"});
    inp.placeholder=ph||""; parent.appendChild(inp); return inp;
  }
  var bwrap=el("div",{marginTop:"16px",paddingTop:"14px",borderTop:"1px solid #3a3a3a"});
  bwrap.appendChild(el("div",{fontSize:"14px",fontWeight:"600",marginBottom:"8px"},"Backend (scaffold \\u00d7 model)"));
  var brow=el("div",{display:"flex",gap:"8px",marginBottom:"4px"});
  var scaffold="codex";
  function styleScaf(btn,v){btn.style.border="2px solid "+(scaffold===v?"#7c6af7":"#444");btn.style.background=scaffold===v?"#2d2060":"#2a2a2a";}
  var codexBtn=el("button",{flex:"1",padding:"10px 0",borderRadius:"8px",color:"#e0e0e0",cursor:"pointer",fontSize:"13px",fontWeight:"500"},"Codex (GPT)");
  var claudeBtn=el("button",{flex:"1",padding:"10px 0",borderRadius:"8px",color:"#e0e0e0",cursor:"pointer",fontSize:"13px",fontWeight:"500"},"Claude Code");
  var cf=el("div",{display:"none"});
  var modelInp=mkInput(cf,"Claude model (optional)","claude-opus-4-8 / claude-sonnet-4-6");
  var hostInp=mkInput(cf,"Remote host (optional, ssh)","user@host \\u2014 blank = local");
  var portInp=mkInput(cf,"Remote SSH port (optional)","22");
  var pwInp=mkInput(cf,"Remote SSH password (optional, saved)","blank = key/agent auth");
  pwInp.type="password";
  var tokInp=mkInput(cf,"Remote Claude token (run: claude setup-token)","CLAUDE_CODE_OAUTH_TOKEN or sk-ant-api\\u2026");
  tokInp.type="password";
  function setScaf(v){scaffold=v;styleScaf(codexBtn,"codex");styleScaf(claudeBtn,"claude");cf.style.display=v==="claude"?"block":"none";}
  codexBtn.onclick=function(){setScaf("codex");}; claudeBtn.onclick=function(){setScaf("claude");};
  brow.appendChild(codexBtn); brow.appendChild(claudeBtn);
  bwrap.appendChild(brow); bwrap.appendChild(cf);
  var bInfo=el("div",{fontSize:"11px",color:"#7a9a7a",margin:"6px 0",whiteSpace:"pre-wrap"});
  bwrap.appendChild(bInfo);
  // Flat unified model list — one [harness]-[model] dropdown (the app's own
  // power-slider picker only surfaces a few codex models, so we provide this).
  // Selecting an entry sets scaffold+model, which the cc-bridge routes on.
  bwrap.appendChild(el("div",{fontSize:"12px",color:"#999",margin:"8px 0 4px"},"Model — [harness]-[model]"));
  var pick=el("select",{width:"100%",boxSizing:"border-box",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"8px",color:"#e0e0e0",fontSize:"13px",marginBottom:"8px"});
  var ph0=el("option",null,"\\u2014 pick a model \\u2014"); ph0.value=""; pick.appendChild(ph0);
  if(window.codexModels&&window.codexModels.get)window.codexModels.get().then(function(l){ (l||[]).forEach(function(m){ var o=el("option",null,m.model); o.value=m.model; pick.appendChild(o); }); if(!l||!l.length){var o=el("option",null,"(fetch models first \\u2191)");o.value="";pick.appendChild(o);} });
  pick.onchange=function(){ var v=pick.value; if(!v)return; var mm=/^\\[(codex|claude_code|claude)\\]-(.+)$/.exec(v); if(!mm)return; var isC=mm[1]!=="codex"; setScaf(isC?"claude":"codex"); if(isC)modelInp.value=mm[2]; if(window.codexModels&&window.codexModels.setBackend)window.codexModels.setBackend({scaffold:isC?"claude":"codex",model:isC?mm[2]:undefined,host:hostInp.value.trim()||undefined,port:portInp.value.trim()||undefined,password:pwInp.value||undefined,token:tokInp.value.trim()||undefined}).then(function(){ bInfo.textContent="Backend = "+v+" — applies on the next turn."; }); };
  bwrap.appendChild(pick);
  var applyBtn=el("button",{marginTop:"6px",width:"100%",padding:"9px 0",borderRadius:"8px",border:"none",background:"#7c6af7",color:"#fff",fontWeight:"600",cursor:"pointer"},"Apply backend");
  applyBtn.onclick=function(){ if(!(window.codexModels&&window.codexModels.setBackend))return; window.codexModels.setBackend({scaffold:scaffold,model:modelInp.value.trim()||undefined,host:hostInp.value.trim()||undefined,port:portInp.value.trim()||undefined,password:pwInp.value||undefined,token:tokInp.value.trim()||undefined}).then(function(){ bInfo.textContent="Saved. Reload to switch scaffold; model/host/token apply on the next turn."; }); };
  bwrap.appendChild(applyBtn);
  if(window.codexModels&&window.codexModels.getBackend)window.codexModels.getBackend().then(function(b){ setScaf(b&&b.scaffold==="claude"?"claude":"codex"); if(b){modelInp.value=b.model||"";hostInp.value=b.host||"";portInp.value=b.port||"";pwInp.value=b.password||"";tokInp.value=b.token||"";} });
  else setScaf("codex");
  box.appendChild(bwrap);

  // ── Feature C: Debate / Brainstorm builder ──
  var dwrap=el("div",{marginTop:"16px",paddingTop:"14px",borderTop:"1px solid #3a3a3a"});
  dwrap.appendChild(el("div",{fontSize:"14px",fontWeight:"600",marginBottom:"8px"},"Debate / Brainstorm"));
  dwrap.appendChild(el("div",{fontSize:"11px",color:"#999",marginBottom:"8px"},"Pick two models → adds \\u201cDebate-[m1]-vs-[m2]\\u201d to the model list."));
  var drow=el("div",{display:"flex",gap:"8px",marginBottom:"8px",flexWrap:"wrap"});
  var dSel1=el("select",{flex:"1",minWidth:"120px",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"7px 9px",color:"#e0e0e0",fontSize:"12px"});
  var dSel2=el("select",{flex:"1",minWidth:"120px",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"7px 9px",color:"#e0e0e0",fontSize:"12px"});
  function populateDebatePickers(list){
    [dSel1,dSel2].forEach(function(s,i){
      s.innerHTML="";
      (list||[]).forEach(function(m){var o=el("option",null,m.model);o.value=m.model;s.appendChild(o);});
      if(list&&list.length>1&&i===1){s.selectedIndex=1;}
    });
  }
  if(window.codexModels&&window.codexModels.get)window.codexModels.get().then(function(l){populateDebatePickers(l||[]);});
  drow.appendChild(dSel1); drow.appendChild(el("div",{lineHeight:"34px",color:"#777"},"vs")); drow.appendChild(dSel2);
  dwrap.appendChild(drow);
  var dInfo=el("div",{fontSize:"11px",color:"#7a9a7a",margin:"4px 0 8px",whiteSpace:"pre-wrap"});
  dwrap.appendChild(dInfo);
  var dAddBtn=el("button",{width:"100%",padding:"8px 0",borderRadius:"8px",border:"none",background:"#7c6af7",color:"#fff",fontWeight:"600",cursor:"pointer"},"Add to model list");
  dAddBtn.onclick=function(){
    var m1=dSel1.value,m2=dSel2.value;
    if(!m1||!m2||m1===m2){dInfo.textContent="Pick two different models.";return;}
    var debateId="Debate-"+m1+"-vs-"+m2;
    if(!window.codexModels){dInfo.textContent="bridge unavailable";return;}
    window.codexModels.get().then(function(list){
      list=list||[];
      if(list.some(function(x){return x.model===debateId;})){dInfo.textContent="Already in list: "+debateId;return;}
      list.push({model:debateId,displayName:"\\u2694\\ufe0f Debate · "+m1+" vs "+m2,hidden:false,isDefault:false,supportedReasoningEfforts:[]});
      return window.codexModels.set(list).then(function(){dInfo.textContent="Added: "+debateId+"\\nReload to see it in the picker.";});
    }).catch(function(e){dInfo.textContent="Error: "+e.message;});
  };
  dwrap.appendChild(dAddBtn);
  box.appendChild(dwrap);

  (document.body||document.documentElement).appendChild(box);
}
function injectMenuOption(){
  Array.prototype.forEach.call(document.querySelectorAll('[role="menu"]'),function(menu){
    if(menu.querySelector('[data-cc-add-model]'))return;
    var list=menu.querySelector('.vertical-scroll-fade-mask');
    var hasModels=menu.querySelector('[data-model-picker-model-row]')||menu.querySelector('[data-model-selected]')||list&&list.querySelector('[role="menuitem"]');
    if(!hasModels)return;
    var wrap=el("div",{borderTop:"1px solid rgba(255,255,255,0.09)",paddingTop:"4px",marginTop:"4px"});wrap.setAttribute("data-cc-add-model","1");
    var sample=Array.prototype.find.call(menu.querySelectorAll('[role="menuitem"]'),function(item){var r=item.getBoundingClientRect();return r.width>40&&r.height>20;});
    var button=el("button",{display:"flex",alignItems:"center",gap:"8px",width:"100%",minHeight:"32px",padding:"6px 8px",border:"none",borderRadius:"4px",background:"transparent",color:"inherit",fontFamily:"inherit",fontSize:"inherit",textAlign:"left",cursor:"pointer"});
    if(sample&&sample.className)button.className=sample.className;button.type="button";button.setAttribute("role","menuitem");button.setAttribute("aria-label","Add custom model");
    var plus=el("span",{width:"16px",fontSize:"18px",lineHeight:"16px",textAlign:"center",color:"#999"},"+");plus.setAttribute("aria-hidden","true");button.appendChild(plus);button.appendChild(el("span",null,"Add custom model"));
    button.onpointerdown=function(e){e.preventDefault();e.stopPropagation();};button.onclick=function(e){e.preventDefault();e.stopPropagation();setTimeout(function(){openPanel();},0);};
    wrap.appendChild(button);(list&&list.parentElement?list.parentElement:menu).appendChild(wrap);
  });
}
var menuScanTimer=null;
function init(){
  injectMenuOption();
  new MutationObserver(function(){if(menuScanTimer)return;menuScanTimer=setTimeout(function(){menuScanTimer=null;injectMenuOption();},30);}).observe(document.body||document.documentElement,{childList:true,subtree:true});
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
`;

function patchRendererUi(bundles) {
  let patched = 0;
  for (const b of bundles) {
    const code = fs.readFileSync(b.path, "utf-8");
    const refreshed = replaceInjectedIife(code, "if(window.__codexModelsUiInstalled)return;", UI_INJECT);
    fs.writeFileSync(b.path, refreshed == null ? code + UI_INJECT : refreshed);
    console.log(`  [ok] ${relPath(b.path)}: custom-models panel ${refreshed == null ? "injected" : "refreshed"}`);
    patched++;
  }
  return patched;
}

// ─── Conversation controls (undo / edit-branch / model-switch) ────────────────
// Rewritten to drive the app's OWN store-synced host commands instead of typing
// dead fake slash commands. IDs come from the React fiber on each user bubble
// (the same source the native "Edit user message" affordance reads); the actions
// call the command registry + rollback helper exposed on globalThis.__ccHost by
// patch-conv-host.js:
//   __ccHost.registry["edit-last-user-turn-for-host"](mgr, {...})  — edit + branch
//   __ccHost.syncRollback(conversationId, numTurns)                — multi-turn undo
//   __ccHost.registry["update-thread-settings-for-next-turn"](...) — model/harness
// All three keep the DOM in sync with no reload. For local threads the fiber's
// conversationId IS the backend threadId (conv.id === sessionId === fiber id).
const CONV_CONTROLS_INJECT = `
;(function(){
if(window.__ccConvControlsInstalled)return;
window.__ccConvControlsInstalled=true;
var FONT="system-ui,-apple-system,Segoe UI,sans-serif";
function el(t,s,x){var n=document.createElement(t);if(s)for(var k in s)n.style[k]=s[k];if(x!=null)n.textContent=x;return n;}
function host(){return globalThis.__ccHost||null;}
// Walk the React fiber on/above a user bubble to recover the live turn ids the
// native edit affordance uses. turnId changes after every edit, so always read fresh.
function bubbleIds(bubble){
  var fk=null,node=bubble,hops=0;
  while(!fk&&node&&hops<6){fk=Object.keys(node).find(function(k){return k.indexOf("__reactFiber")===0;});if(!fk){node=node.parentElement;hops++;}}
  if(!fk)return null;
  var fiber=node[fk],out={},h=0;
  while(fiber&&h<30){
    var p=fiber.memoizedProps;
    if(p&&typeof p==="object"){
      if(p.turnId&&!out.turnId)out.turnId=p.turnId;
      if(p.conversationId&&!out.conversationId)out.conversationId=p.conversationId;
      if(p.agentMode&&!out.agentMode)out.agentMode=p.agentMode;
      if(p.message!=null&&out.message==null)out.message=(typeof p.message==="string")?p.message:(p.message&&p.message.text)||null;
    }
    fiber=fiber.return;h++;
  }
  return (out.turnId&&out.conversationId)?out:null;
}
function allUserBubbles(){return Array.prototype.slice.call(document.querySelectorAll("[data-user-message-bubble=true]"));}
function toast(msg,bad){
  var t=el("div",{position:"fixed",bottom:"96px",left:"50%",transform:"translateX(-50%)",zIndex:"2147483647",background:bad?"#5a2030":"#1e1e1e",color:"#e0e0e0",border:"1px solid "+(bad?"#a04":"#555"),borderRadius:"8px",padding:"8px 14px",fontFamily:FONT,fontSize:"12px",boxShadow:"0 4px 16px rgba(0,0,0,0.5)",maxWidth:"70vw"},msg);
  (document.body||document.documentElement).appendChild(t);
  setTimeout(function(){t.remove();},2600);
}
var CC_BKEY="__ccMessageVersionsV2";
function ccLoadBranches(){try{var b=JSON.parse(localStorage.getItem(CC_BKEY))||{};b.groups=b.groups||{};b.t2g=b.t2g||{};b.anchors=b.anchors||{};b.redo=b.redo||{};b.hidden=b.hidden||{};return b;}catch(e){return {groups:{},t2g:{},anchors:{},redo:{},hidden:{}};}}
function ccSaveBranches(b){try{localStorage.setItem(CC_BKEY,JSON.stringify(b));}catch(e){}}
function recordVersion(srcId,forkId,anchorIndex){
  var b=ccLoadBranches();
  var gid=b.t2g[srcId]||srcId;
  var members=b.groups[gid]||[srcId];
  if(members.indexOf(srcId)<0)members.push(srcId);
  if(members.indexOf(forkId)<0)members.push(forkId);
  b.groups[gid]=members;b.t2g[srcId]=gid;b.t2g[forkId]=gid;b.anchors[gid]=anchorIndex;b.hidden[forkId]=1;
  ccSaveBranches(b);
}
function recordUndo(undoId,redoId){var b=ccLoadBranches();b.redo[undoId]=redoId;b.hidden[undoId]=1;ccSaveBranches(b);}
function redoTarget(threadId){var b=ccLoadBranches();return threadId&&b.redo[threadId]||null;}
function branchInfo(threadId){
  if(!threadId)return null;
  var b=ccLoadBranches(),gid=b.t2g[threadId];if(!gid)return null;
  var members=b.groups[gid]||[];if(members.length<2)return null;
  return {members:members,idx:members.indexOf(threadId),gid:gid,anchor:b.anchors[gid]||0};
}
function currentThreadId(){
  var bubbles=allUserBubbles();
  for(var i=bubbles.length-1;i>=0;i--){var ids=bubbleIds(bubbles[i]);if(ids&&ids.conversationId)return ids.conversationId;}
  return globalThis.__ccCurrentThread||null;
}
function goThread(id){
  var h=host();if(!id||!h||!h.registry||!globalThis.__ccNavigate)return Promise.reject(Error("navigation unavailable"));
  var mgr=h.manager(),lm=mgr.getManagerForHostId("local"),c=lm.getConversation(id)||{};
  var params={hostId:"local",conversationId:id,model:null,serviceTier:null,reasoningEffort:null,workspaceRoots:c.cwd?[c.cwd]:[],collaborationMode:c.latestCollaborationMode||undefined};
  return Promise.resolve(h.registry["maybe-resume-conversation"](mgr,params)).catch(function(){}).then(function(){globalThis.__ccNavigate(id);});
}
function sidebarThreadId(item){
  var node=item,fiberKey=null,h=0;
  while(!fiberKey&&node&&h<5){fiberKey=Object.keys(node).find(function(k){return k.indexOf("__reactFiber")===0;});if(!fiberKey){node=node.parentElement;h++;}}
  if(!fiberKey)return null;
  var fiber=node[fiberKey],i=0;
  while(fiber&&i<25){var p=fiber.memoizedProps;if(p&&typeof p.item==="string"&&p.item.indexOf("local:")===0)return p.item.slice(6);fiber=fiber.return;i++;}
  return null;
}
function hideVersionRows(){
  var hidden=ccLoadBranches().hidden;
  Array.prototype.forEach.call(document.querySelectorAll('[role="listitem"]'),function(item){var id=sidebarThreadId(item);if(id&&hidden[id])item.style.display="none";});
}
// Undo is non-destructive: create a rolled-back version, hide its task row, then
// navigate to it. Redo switches back to the original full version.
function undoToHere(bubble){
  var h=host();if(!h||typeof h.forkRollback!=="function"){toast("host bridge unavailable",true);return;}
  var ids=bubbleIds(bubble);if(!ids){toast("could not resolve turn id",true);return;}
  var bubbles=allUserBubbles();
  var idx=bubbles.indexOf(bubble);
  var num=(idx<0)?1:(bubbles.length-idx);
  h.forkRollback(ids.conversationId,num).then(function(undoId){
    recordUndo(undoId,ids.conversationId);
    return goThread(undoId);
  }).then(function(){
    toast("Undid "+num+" turn"+(num>1?"s":""));
  }).catch(function(e){toast("Undo failed: "+e.message,true);});
}
function redoLast(){
  var target=redoTarget(currentThreadId());
  if(!target){toast("Nothing to redo",true);return;}
  goThread(target).catch(function(e){toast("Redo failed: "+e.message,true);});
}
function updateGlobalRedo(){
  var target=redoTarget(currentThreadId()),btn=document.getElementById("__cc-global-redo");
  if(!target||allUserBubbles().length){if(btn)btn.style.display="none";return;}
  if(!btn){
    btn=el("button",{position:"fixed",right:"58px",bottom:"18px",zIndex:"2147483644",border:"1px solid #555",background:"#242424",color:"#aaa",borderRadius:"6px",padding:"4px 8px",fontSize:"11px",cursor:"pointer",fontFamily:FONT},"Redo");
    btn.id="__cc-global-redo";btn.title="Redo the last undo";btn.onclick=redoLast;(document.body||document.documentElement).appendChild(btn);
  }
  btn.style.display="block";
}
// Edit an older bubble as an in-conversation version. The copied thread is hidden
// from the sidebar, rolled back through the edited turn, then receives the new
// message. The inline k/N selector switches versions.
function editHere(bubble){
  var h=host();if(!h||!h.registry||typeof h.forkRollback!=="function"){toast("host bridge unavailable",true);return;}
  var ids=bubbleIds(bubble);if(!ids){toast("could not resolve turn id",true);return;}
  if(bubble.parentElement&&bubble.parentElement.querySelector("[data-cc-edit-box]"))return;
  var orig=ids.message||bubble.innerText||"";
  var editBox=el("textarea",{width:"100%",minHeight:"64px",background:"#1e1e1e",color:"#e0e0e0",border:"1px solid #7c6af7",borderRadius:"8px",padding:"8px",fontSize:"13px",resize:"vertical",boxSizing:"border-box",marginTop:"6px",fontFamily:FONT});
  editBox.setAttribute("data-cc-edit-box","1");editBox.value=orig;
  var row=el("div",{display:"flex",gap:"6px",marginTop:"6px",justifyContent:"flex-end",alignItems:"center"});
  var ok=el("button",{padding:"5px 12px",borderRadius:"6px",border:"none",background:"#7c6af7",color:"#fff",fontSize:"12px",fontWeight:"600",cursor:"pointer"},"Save");
  var cancel=el("button",{padding:"5px 12px",borderRadius:"6px",border:"1px solid #555",background:"transparent",color:"#aaa",fontSize:"12px",cursor:"pointer"},"Cancel");
  row.appendChild(cancel);row.appendChild(ok);
  var holder=bubble.parentElement||bubble;
  holder.appendChild(editBox);holder.appendChild(row);editBox.focus();
  function cleanup(){editBox.remove();row.remove();}
  cancel.onclick=cleanup;
  ok.onclick=function(){
    var txt=editBox.value.trim();if(!txt){cleanup();return;}
    ok.disabled=true;ok.textContent="Saving\\u2026";
    var mgr=h.manager(),lm=mgr.getManagerForHostId("local");
    var bubbles=allUserBubbles(),idx=bubbles.indexOf(bubble);
    var num=(idx<0)?1:(bubbles.length-idx);
    Promise.resolve(h.forkRollback(ids.conversationId,num)).then(function(forkId){
      if(!forkId||typeof forkId!=="string")throw Error("version did not return a thread id");
      recordVersion(ids.conversationId,forkId,idx<0?0:idx);
      return h.registry["send-follow-up-message"](mgr,{
        hostId:"local",conversationId:forkId,prompt:txt,
        model:null,reasoningEffort:null,serviceTier:null,messageMetadata:null
      }).then(function(){return goThread(forkId);});
    }).then(function(){cleanup();toast("Saved as version");})
      .catch(function(e){ok.disabled=false;ok.textContent="Save";toast("Edit failed: "+e.message,true);});
  };
}
function laterPromptsAfter(bubble){
  var bubbles=allUserBubbles(),idx=bubbles.indexOf(bubble),out=[];
  if(idx<0)return out;
  for(var i=idx+1;i<bubbles.length;i++){
    var ids=bubbleIds(bubbles[i]);
    var txt=(ids&&ids.message)||bubbles[i].innerText||"";
    txt=String(txt).trim();
    if(txt)out.push(txt);
  }
  return out;
}
function waitThreadIdle(threadId,timeoutMs){
  var h=host(),mgr=h&&h.manager&&h.manager(),lm=mgr&&mgr.getManagerForHostId&&mgr.getManagerForHostId("local");
  var started=Date.now();
  return new Promise(function(resolve){
    function check(){
      var idle=true;
      try{
        var c=lm&&lm.getConversation&&lm.getConversation(threadId);
        var turns=(c&&c.turns)||[];
        var last=turns.length?turns[turns.length-1]:null;
        var runtime=c&&c.threadRuntimeStatus&&c.threadRuntimeStatus.type;
        idle=(!last||last.status!=="inProgress")&&runtime!=="active";
      }catch(e){idle=true;}
      if(idle||Date.now()-started>(timeoutMs||120000))resolve();
      else setTimeout(check,700);
    }
    check();
  });
}
function replayPrompts(threadId,prompts){
  var h=host(),mgr=h.manager();
  var p=Promise.resolve();
  prompts.forEach(function(prompt){
    p=p.then(function(){
      return h.registry["send-follow-up-message"](mgr,{
        hostId:"local",conversationId:threadId,prompt:prompt,
        model:null,reasoningEffort:null,serviceTier:null,messageMetadata:null
      });
    }).then(function(){return waitThreadIdle(threadId,120000);});
  });
  return p;
}
// Delete one user turn from context. For middle turns, fork at the current thread,
// roll back through the selected turn, then replay later user prompts in order so
// the new version preserves the rest of the conversation without the deleted query
// or its assistant/thinking output contaminating context.
function deleteTurn(bubble){
  var h=host();if(!h||!h.registry||typeof h.forkRollback!=="function"){toast("host bridge unavailable",true);return;}
  var ids=bubbleIds(bubble);if(!ids){toast("could not resolve turn id",true);return;}
  var bubbles=allUserBubbles(),idx=bubbles.indexOf(bubble);
  if(idx<0){toast("could not locate bubble",true);return;}
  if(!confirm("Delete this query and regenerate later turns in the background?"))return;
  var prompts=laterPromptsAfter(bubble);
  var num=bubbles.length-idx;
  toast("Deleting turn...");
  h.forkRollback(ids.conversationId,num).then(function(forkId){
    if(!forkId||typeof forkId!=="string")throw Error("delete version did not return a thread id");
    recordVersion(ids.conversationId,forkId,Math.max(0,idx-1));
    return goThread(forkId).then(function(){
      toast(prompts.length?"Deleted; replaying "+prompts.length+" later prompt(s) in background":"Deleted turn");
      if(prompts.length){
        replayPrompts(forkId,prompts).then(function(){
          toast("Replay complete");
        }).catch(function(e){
          toast("Replay failed: "+e.message,true);
        });
      }
      return forkId;
    });
  }).then(function(){
  }).catch(function(e){toast("Delete failed: "+e.message,true);});
}
function findActionRow(bubble){
  var group=bubble;
  while(group&&group!==document.body){
    var copy=group.querySelector&&group.querySelector('button[aria-label="Copy message"]');
    if(copy){
      var row=copy;
      while(row&&row!==group){if(String(row.className||"").indexOf("gap-0.5")>=0)return row;row=row.parentElement;}
    }
    group=group.parentElement;
  }
  return null;
}
// In-bubble version selector "‹ k/N ›" (ChatGPT-style), anchored under the
// message that was edited rather than under the final message.
function branchArrow(txt,title){
  var b=el("button",{border:"none",background:"transparent",color:"#8a8a8a",cursor:"pointer",fontSize:"14px",lineHeight:"14px",padding:"0 3px"},txt);
  b.title=title;
  b.onmouseenter=function(){b.style.color="#ccc";};
  b.onmouseleave=function(){b.style.color="#8a8a8a";};
  return b;
}
function updateBranchNav(){
  var info=branchInfo(currentThreadId());
  var existing=Array.prototype.slice.call(document.querySelectorAll("[data-cc-branch-nav]"));
  if(!info){existing.forEach(function(e){e.remove();});return;}
  var bubbles=allUserBubbles();
  var target=bubbles[Math.min(info.anchor,bubbles.length-1)];
  if(!target){existing.forEach(function(e){e.remove();});return;}
  var bar=findActionRow(target);
  if(!bar){existing.forEach(function(e){e.remove();});return;}
  existing.forEach(function(e){if(e.parentElement!==bar)e.remove();});
  var nav=bar.querySelector("[data-cc-branch-nav]");
  if(!nav){
    nav=el("span",{display:"inline-flex",alignItems:"center",gap:"2px",marginLeft:"6px"});
    nav.setAttribute("data-cc-branch-nav","1");
    var prev=branchArrow("\\u2039","Previous branch");
    var label=el("span",{minWidth:"26px",textAlign:"center",color:"#9a9a9a",fontSize:"12px"});
    var next=branchArrow("\\u203a","Next branch");
    nav.appendChild(prev);nav.appendChild(label);nav.appendChild(next);
    bar.appendChild(nav);
    nav._label=label;
    prev.onclick=function(e){e.stopPropagation();var i=branchInfo(currentThreadId());if(!i)return;goThread(i.members[(i.idx-1+i.members.length)%i.members.length]);};
    next.onclick=function(e){e.stopPropagation();var i=branchInfo(currentThreadId());if(!i)return;goThread(i.members[(i.idx+1)%i.members.length]);};
  }
  nav._label.textContent=(info.idx+1)+"/"+info.members.length;
  // Keep the action row visible when a branch selector is present.
  bar.style.opacity="1";
}
function compactAction(label,title,fn,bubble){
  var b=el("button",{border:"none",background:"transparent",color:"#8a8a8a",fontSize:"11px",cursor:"pointer",padding:"2px 4px",lineHeight:"16px",fontFamily:FONT},label);
  b.title=title;b.setAttribute("data-cc-action","1");
  b.onclick=function(e){e.stopPropagation();e.preventDefault();fn(bubble);};
  return b;
}
function editIconFor(bubble){
  var template=document.querySelector('button[aria-label="Edit message"]');
  if(!template)return null;
  var b=template.cloneNode(true);
  b.removeAttribute("data-state");b.setAttribute("data-cc-edit-icon","1");
  b.title="Edit message";b.setAttribute("aria-label","Edit message");
  b.onclick=function(e){e.stopPropagation();e.preventDefault();editHere(bubble);};
  return b;
}
// Add controls to the app's native Copy/Edit action row. The app only renders its
// own pencil on the latest bubble; clone that exact icon for older bubbles.
function decorateBubbles(root){
  if(!root||root.nodeType!==1)return;
  var bubbles=root.matches&&root.matches("[data-user-message-bubble=true]")?[root]:[];
  if(root.querySelectorAll)bubbles=bubbles.concat(Array.prototype.slice.call(root.querySelectorAll("[data-user-message-bubble=true]")));
  bubbles.forEach(function(bubble){
    var row=findActionRow(bubble);if(!row)return;
    var old=(bubble.parentElement||bubble).querySelector("[data-cc-bubble-actions]");if(old)old.remove();
    if(!row.querySelector('button[aria-label="Edit message"]')){var pencil=editIconFor(bubble);if(pencil)row.appendChild(pencil);}
    if(!row.querySelector('[data-cc-action="undo"]')){
      var undo=compactAction("Undo","Undo to this message",undoToHere,bubble);undo.setAttribute("data-cc-action","undo");row.appendChild(undo);
      var del=compactAction("Delete","Delete this query and regenerate later turns without it",deleteTurn,bubble);del.setAttribute("data-cc-action","delete");del.style.color="#c77";row.appendChild(del);
      var redo=compactAction("Redo","Redo the last undo",function(){redoLast();},bubble);redo.setAttribute("data-cc-action","redo");row.appendChild(redo);
    }
    var redoBtn=row.querySelector('[data-cc-action="redo"]');if(redoBtn)redoBtn.disabled=!redoTarget(currentThreadId());
  });
  updateBranchNav();
  updateGlobalRedo();
  hideVersionRows();
}
// ── Model / harness switch (next turn) — kept from the prior build ──
function injectSwitchBtn(){
  if(document.getElementById("__cc-sw-btn"))return;
  var btn=el("button",{position:"fixed",bottom:"56px",left:"16px",zIndex:"2147483644",height:"30px",padding:"0 10px",borderRadius:"15px",background:"#2a2a2a",border:"1px solid #555",color:"#aaa",fontSize:"12px",cursor:"pointer",fontFamily:FONT,boxShadow:"0 2px 8px rgba(0,0,0,0.4)"},"\\u21c4 Model");
  btn.id="__cc-sw-btn";
  btn.onclick=function(){
    var old=document.getElementById("__cc-sw-panel");if(old){old.remove();return;}
    var box=el("div",{position:"fixed",bottom:"92px",left:"16px",zIndex:"2147483645",width:"320px",background:"#1e1e1e",color:"#e0e0e0",border:"1px solid #444",borderRadius:"10px",padding:"14px",boxShadow:"0 8px 30px rgba(0,0,0,0.6)",fontFamily:FONT,fontSize:"13px"});
    box.id="__cc-sw-panel";
    box.appendChild(el("div",{fontSize:"14px",fontWeight:"600",marginBottom:"8px"},"Switch Model / Harness"));
    box.appendChild(el("div",{fontSize:"11px",color:"#999",marginBottom:"8px"},"Takes effect on the next turn."));
    var hRow=el("div",{display:"flex",gap:"6px",marginBottom:"8px"});
    var harnessVal="codex";
    ["codex","claude_code"].forEach(function(h){
      var hb=el("button",{flex:"1",padding:"6px 0",borderRadius:"6px",border:"1px solid #555",background:"#2a2a2a",color:"#ccc",fontSize:"12px",cursor:"pointer"},h==="codex"?"Codex":"Claude Code");
      hb.onclick=function(){hRow.querySelectorAll("button").forEach(function(b){b.style.background="#2a2a2a";b.style.borderColor="#555";});hb.style.background="#2d2060";hb.style.borderColor="#7c6af7";harnessVal=h;};
      hRow.appendChild(hb);
    });
    box.appendChild(hRow);
    box.appendChild(el("div",{fontSize:"11px",color:"#999",marginBottom:"3px"},"Model ID"));
    var inp=el("input",{width:"100%",boxSizing:"border-box",background:"#2a2a2a",border:"1px solid #444",borderRadius:"6px",padding:"6px 8px",color:"#e0e0e0",fontSize:"12px",marginBottom:"8px"});
    inp.placeholder="e.g. gpt-5.6 or claude-opus-4-8";box.appendChild(inp);
    var applyBtn=el("button",{width:"100%",padding:"7px 0",borderRadius:"6px",border:"none",background:"#7c6af7",color:"#fff",fontWeight:"600",fontSize:"13px",cursor:"pointer"},"Apply on Next Turn");
    applyBtn.onclick=function(){
      var model=inp.value.trim();if(!model)return;
      if(window.codexModels&&window.codexModels.setBackend){
        window.codexModels.setBackend({scaffold:harnessVal,model:model}).then(function(r){
          applyBtn.textContent=r&&r.ok?"\\u2713 "+harnessVal+":"+model+" set":"Error";
          setTimeout(function(){box.remove();},1600);
        });
      }else{applyBtn.textContent="bridge unavailable";}
    };
    box.appendChild(applyBtn);
    (document.body||document.documentElement).appendChild(box);
  };
  (document.body||document.documentElement).appendChild(btn);
}
// Rescan the whole document (debounced) on ANY DOM mutation. decorateBubbles is
// idempotent (skips bubbles whose holder already has an action bar), so a full
// rescan is cheap and reliable across SPA navigations where the newly-rendered
// bubbles can arrive deep inside a single coalesced mutation.
var _ccRescan=null;
var obs=new MutationObserver(function(){
  if(_ccRescan)return;
  _ccRescan=setTimeout(function(){_ccRescan=null;decorateBubbles(document.body||document.documentElement);},120);
});
function boot(){
  obs.observe(document.body||document.documentElement,{childList:true,subtree:true});
  decorateBubbles(document.body||document.documentElement);
  // The branch pill depends on which thread is displayed, which can change via
  // sidebar clicks that don't add bubbles — refresh it on a light interval too.
  setInterval(function(){updateBranchNav();updateGlobalRedo();hideVersionRows();},700);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
`;

function patchConvControls(bundles) {
  let patched = 0;
  for (const b of bundles) {
    const code = fs.readFileSync(b.path, "utf-8");
    let next = code;
    if (code.includes("__ccConvControlsInstalled")) {
      const marker = "if(window.__ccConvControlsInstalled)return;";
      const markerIdx = code.indexOf(marker);
      const start = code.lastIndexOf(";(function(){", markerIdx);
      const end = code.indexOf("\n})();", markerIdx);
      if (start < 0 || end < 0) {
        console.log(`  [!] ${relPath(b.path)}: existing conv-controls block boundary not found`);
        continue;
      }
      next = code.slice(0, start) + code.slice(end + "\n})();".length);
      console.log(`  [ok] ${relPath(b.path)}: existing conv-controls refreshed`);
    } else {
      console.log(`  [ok] ${relPath(b.path)}: conv-controls injected`);
    }
    fs.writeFileSync(b.path, next + CONV_CONTROLS_INJECT);
    patched++;
  }
  return patched;
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const opts = platform ? { platform } : {};

  console.log("  [layer 1] app-main: codex-models ipc handlers");
  const ipcBundles = [
    ...locateBundles({ dir: "build", pattern: /^main-.*\.js$/, all: true, ...opts }),
    ...locateBundles({ dir: "build", pattern: /^src-.*\.js$/, all: true, ...opts }),
  ];
  const ipc = patchIpc(ipcBundles);

  console.log("  [layer 2] preload: window.codexModels bridge");
  const pre = patchPreload(opts);

  console.log("  [layer 3] model-queries: custom list override");
  const mq = patchModelQueries(opts);

  console.log("  [layer 4] renderer: custom-models panel");
  const ui = patchRendererUi(locateRendererEntry(opts));

  console.log("  [layer 5] renderer: conv-controls (undo/branch/model-switch)");
  const cc = patchConvControls(locateRendererEntry(opts));

  console.log(`  [done] ipc:${ipc} preload:${pre} queryFn:${mq} ui:${ui} cc:${cc}`);
  if (mq === 0) { console.error("  [x] model-queries queryFn matched 0 — upstream layout changed"); process.exit(1); }
  if (pre === 0) { console.error("  [x] preload bridge matched 0"); process.exit(1); }
  if (ui === 0) { console.error("  [x] renderer panel matched 0"); process.exit(1); }
  if (cc === 0) { console.error("  [x] conv-controls matched 0"); process.exit(1); }
}

if (require.main === module) main();

module.exports = {
  IPC_INJECT,
  PRELOAD_INJECT,
  UI_INJECT,
  CONV_CONTROLS_INJECT,
  replaceInjectedIife,
};
