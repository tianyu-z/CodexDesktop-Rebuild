#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const VERSION = 1;

function locateRendererEntry(opts) {
  const platforms = opts.platform ? [opts.platform] : ["mac-arm64", "mac-x64", "win"];
  const out = [];
  for (const platform of platforms) {
    const dir = path.join(SRC_DIR, platform, "_asar", "webview");
    const htmlFile = path.join(dir, "index.html");
    if (!fs.existsSync(htmlFile)) continue;
    const html = fs.readFileSync(htmlFile, "utf8");
    const match = html.match(/src="\.?\/?assets\/(index-[A-Za-z0-9_-]+\.js)"/);
    if (!match) continue;
    const file = path.join(dir, "assets", match[1]);
    if (fs.existsSync(file)) out.push({ platform, path: file });
  }
  return out;
}

const IPC_START = `;/*__CODEX_ENSEMBLE_IPC_V${VERSION}_START__*/`;
const IPC_END = `/*__CODEX_ENSEMBLE_IPC_V${VERSION}_END__*/;`;
const IPC_INJECT = `
${IPC_START}
;(function(){
var __e=require("electron"),__fs=require("fs"),__path=require("path"),__os=require("os");
if(!__e||!__e.ipcMain)return;
if(global.__codexEnsembleIpcRegistered)return;
global.__codexEnsembleIpcRegistered=true;
function __file(){return __path.join(__os.homedir(),".codex","cc-bridge","ensemble.json");}
function __normalize(raw){
  raw=raw&&typeof raw==="object"?raw:{};var used={},models=[];
  (Array.isArray(raw.models)?raw.models:[]).forEach(function(m){
    if(!m)return;var object=typeof m==="object",rawModel=String(object?(m.model||""):m).trim();
    var tagged=/^\[(codex|claude_code|claude)\]-(.+)$/.exec(rawModel);
    var model=tagged?tagged[2]:rawModel;
    var harness=object?(m.harness==="claude"||m.harness==="claude_code"?"claude":"codex"):(tagged?(tagged[1]==="codex"?"codex":"claude"):/^(claude[-_]|opus|sonnet|haiku|fable)/i.test(model)?"claude":"codex");
    if(!model)return;var base=harness+":"+model,key=String(object&&m.key||base).trim()||base;
    if(used[key]){var instance=2;while(used[base+"#"+instance])instance++;key=base+"#"+instance;}used[key]=true;
    models.push({key:key,harness:harness,model:model,label:String(object&&m.label||rawModel||model)});
  });
  var leader=models.some(function(m){return m.key===raw.leader;})?raw.leader:(models[0]&&models[0].key)||null;
  return {enabled:raw.enabled===true,mode:raw.mode==="debate"?"debate":"brainstorm",rounds:Math.max(1,Math.min(5,parseInt(raw.rounds||1,10)||1)),leader:leader,models:models};
}
__e.ipcMain.handle("codex-ensemble:get",function(){
  try{var p=__file();return __fs.existsSync(p)?__normalize(JSON.parse(__fs.readFileSync(p,"utf8"))):__normalize({});}
  catch(e){return __normalize({});}
});
__e.ipcMain.handle("codex-ensemble:models",function(){
  try{
    var p=__path.join(__os.homedir(),".codex","config.toml"),text=__fs.readFileSync(p,"utf8");
    var m=(text.match(/^\\s*model\\s*=\\s*"([^"]+)"/m)||[])[1];return m?[m]:[];
  }catch(e){return [];}
});
__e.ipcMain.handle("codex-ensemble:set",function(_event,raw){
  var cfg=__normalize(raw);
  if(cfg.enabled&&cfg.models.length<2)throw new Error("Select at least two models");
  if(cfg.enabled&&!cfg.leader)throw new Error("Select a leader model");
  try{
    var p=__file();__fs.mkdirSync(__path.dirname(p),{recursive:true});
    var tmp=p+".tmp";__fs.writeFileSync(tmp,JSON.stringify(cfg,null,2),"utf8");__fs.renameSync(tmp,p);
    return {ok:true,config:cfg};
  }catch(e){throw new Error("Failed to save ensemble configuration: "+e.message);}
});
})();
${IPC_END}
`;

const PRELOAD_START = `;/*__CODEX_ENSEMBLE_PRELOAD_V${VERSION}_START__*/`;
const PRELOAD_END = `/*__CODEX_ENSEMBLE_PRELOAD_V${VERSION}_END__*/;`;
const PRELOAD_INJECT = `
${PRELOAD_START}
;(function(){
try{
  var __e=require("electron");
  if(__e&&__e.contextBridge&&__e.ipcRenderer){
    __e.contextBridge.exposeInMainWorld("codexEnsemble",{
      get:function(){return __e.ipcRenderer.invoke("codex-ensemble:get");},
      models:function(){return __e.ipcRenderer.invoke("codex-ensemble:models");},
      set:function(c){return __e.ipcRenderer.invoke("codex-ensemble:set",c);}
    });
  }
}catch(e){}
})();
${PRELOAD_END}
`;

const RENDERER_START = `;/*__CODEX_ENSEMBLE_RENDERER_V${VERSION}_START__*/`;
const RENDERER_END = `/*__CODEX_ENSEMBLE_RENDERER_V${VERSION}_END__*/;`;
const RENDERER_INJECT = `
${RENDERER_START}
;(function(){
if(window.__codexEnsembleMenuInstalled)return;
window.__codexEnsembleMenuInstalled=true;
var FONT="system-ui,-apple-system,Segoe UI,sans-serif";
function el(tag,style,text){var n=document.createElement(tag);if(style)for(var k in style)n.style[k]=style[k];if(text!=null)n.textContent=text;return n;}
function harnessFor(id){return /^(claude[-_]|opus|sonnet|haiku|fable)/i.test(id)?"claude":"codex";}
function keyFor(h,m){return h+":"+m;}
function modelObject(raw){
  if(!raw)return null;var id=String(raw.model||raw.id||raw).trim();if(!id||/^Debate-/i.test(id))return null;
  var tagged=/^\\[(codex|claude_code|claude)\\]-(.+)$/.exec(id),h=tagged?(tagged[1]==="codex"?"codex":"claude"):harnessFor(id),m=tagged?tagged[2]:id;
  return {key:keyFor(h,m),harness:h,model:m,label:(raw.displayName&&String(raw.displayName))||(raw.label&&String(raw.label))||("["+(h==="claude"?"claude_code":"codex")+"]-"+m)};
}
function availableModels(config){
  var found={},out=[];function add(raw){var m=modelObject(raw);if(m&&!found[m.key]){found[m.key]=true;out.push(m);}}
  (config.models||[]).forEach(add);
  try{(window.__ccMenuModels||[]).forEach(add);}catch(e){}
  var jobs=[];
  if(window.codexEnsemble&&window.codexEnsemble.models)jobs.push(window.codexEnsemble.models().then(function(a){(a||[]).forEach(add);}).catch(function(){}));
  if(window.codexModels&&window.codexModels.get)jobs.push(window.codexModels.get().then(function(a){(a||[]).forEach(add);}).catch(function(){}));
  if(window.codexModels&&window.codexModels.getClaude)jobs.push(window.codexModels.getClaude().then(function(a){(a||[]).forEach(add);}).catch(function(){}));
  return Promise.all(jobs).then(function(){return out.sort(function(a,b){return a.label.localeCompare(b.label);});});
}
var activeEntry=null,activeSubmenu=null,cachedConfig=null;
function defKey(m){return m.harness+":"+m.model;}
function specFor(models,key){for(var i=0;i<models.length;i++)if(models[i].key===key)return models[i];return null;}
function addStyles(){
  if(document.getElementById("__ensemble-menu-styles"))return;
  var css=el("style");css.id="__ensemble-menu-styles";css.textContent=
    ".ensemble-flyout{position:fixed;z-index:2147483646;width:360px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;box-sizing:border-box;padding:12px;background:var(--color-token-dropdown-background,#202020);color:var(--color-token-dropdown-foreground,#ededed);border:1px solid var(--color-token-border-default,#444);border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,.45);font:13px "+FONT+";}"+
    ".ensemble-head,.ensemble-section-head,.ensemble-actions,.ensemble-field,.ensemble-sub-row{display:flex;align-items:center}.ensemble-head,.ensemble-section-head,.ensemble-field{justify-content:space-between}.ensemble-head{margin-bottom:12px}.ensemble-title{font-size:14px;font-weight:600}.ensemble-icon{display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;font-size:18px}.ensemble-icon:hover{background:rgba(255,255,255,.08)}"+
    ".ensemble-field{gap:12px;margin:10px 0}.ensemble-field>span,.ensemble-section-head>span{font-weight:500}.ensemble-select,.ensemble-number{height:32px;box-sizing:border-box;border:1px solid var(--color-token-input-border,#505050);border-radius:5px;background:var(--color-token-input-background,#2a2a2a);color:var(--color-token-input-foreground,inherit);padding:0 8px}.ensemble-select{width:210px;max-width:65%}.ensemble-number{width:64px}.ensemble-sub-list{display:flex;flex-direction:column;gap:6px;margin:7px 0 10px}.ensemble-sub-row{gap:7px}.ensemble-sub-row .ensemble-select{max-width:none;flex:1;width:auto}.ensemble-sub-index{width:18px;color:var(--color-token-text-tertiary,#999);font-size:11px;text-align:right}"+
    ".ensemble-segments{display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:2px;border-radius:6px;background:var(--color-token-bg-secondary,#292929)}.ensemble-segments button{height:28px;padding:0 10px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}.ensemble-segments button[data-active=true]{background:var(--color-token-list-active-selection-background,#464646);color:var(--color-token-list-active-selection-foreground,inherit)}.ensemble-info{min-height:18px;margin-top:8px;font-size:11px;color:var(--color-token-text-tertiary,#999)}.ensemble-actions{justify-content:flex-end;gap:8px;margin-top:8px}.ensemble-action{height:32px;padding:0 12px;border:1px solid var(--color-token-border-default,#505050);border-radius:6px;background:transparent;color:inherit;cursor:pointer}.ensemble-action-primary{border-color:var(--color-token-button-border,transparent);background:var(--color-token-button-background,#3b7d5d);color:var(--color-token-button-foreground,#fff);font-weight:600}";
  (document.head||document.documentElement).appendChild(css);
}
function refreshEntries(cfg){
  cachedConfig=cfg;var count=cfg&&cfg.enabled?(cfg.models||[]).length:0;
  document.querySelectorAll("[data-codex-ensemble-entry=true]").forEach(function(entry){
    var status=entry.querySelector("[data-ensemble-summary]");if(status)status.textContent=count?(count+" agents"):"Off";
    entry.setAttribute("data-active",count?"true":"false");
  });
}
function closeSubmenu(){
  if(activeEntry)activeEntry.setAttribute("aria-expanded","false");
  if(activeSubmenu)activeSubmenu.remove();activeEntry=null;activeSubmenu=null;
}
function positionSubmenu(entry,box){
  var r=entry.getBoundingClientRect(),gap=6,left=r.right+gap;
  if(left+box.offsetWidth>window.innerWidth-8)left=Math.max(8,r.left-box.offsetWidth-gap);
  var top=Math.max(8,Math.min(r.top,window.innerHeight-box.offsetHeight-8));box.style.left=left+"px";box.style.top=top+"px";box.style.visibility="visible";
}
function makeSelect(models,value,label){
  var select=el("select");select.className="ensemble-select";select.setAttribute("aria-label",label);
  models.forEach(function(m){var option=el("option",null,m.label);option.value=m.key;select.appendChild(option);});
  if(value&&specFor(models,value))select.value=value;return select;
}
function renderSubmenu(box,status,cfg,models,entry){
  status.remove();if(!models.length){box.appendChild(el("div",null,"No models available"));return;}
  var configured=cfg.models||[],leaderInstance=configured.find(function(m){return m.key===cfg.leader;})||configured[0];
  var leaderValue=leaderInstance?defKey(leaderInstance):models[0].key;
  var subs=configured.filter(function(m){return !leaderInstance||m.key!==leaderInstance.key;}).map(defKey);
  if(!subs.length)subs.push((models[1]||models[0]).key);
  var mode=cfg.mode==="debate"?"debate":"brainstorm";
  var leaderSelect=makeSelect(models,leaderValue,"Leader agent");
  var leaderRow=el("label");leaderRow.className="ensemble-field";leaderRow.appendChild(el("span",null,"Leader agent"));leaderRow.appendChild(leaderSelect);box.appendChild(leaderRow);
  var section=el("div");section.className="ensemble-section-head";section.appendChild(el("span",null,"Sub agents"));
  var add=el("button",null,"+");add.type="button";add.className="ensemble-icon";add.title="Add sub agent";add.setAttribute("aria-label","Add sub agent");section.appendChild(add);box.appendChild(section);
  var subList=el("div");subList.className="ensemble-sub-list";box.appendChild(subList);
  function drawSubs(){
    subList.textContent="";subs.forEach(function(value,index){
      var row=el("div");row.className="ensemble-sub-row";row.appendChild(el("span"));
      row.firstChild.className="ensemble-sub-index";row.firstChild.textContent=String(index+1);
      var select=makeSelect(models,value,"Sub agent "+(index+1));select.onchange=function(){subs[index]=select.value;};row.appendChild(select);
      var remove=el("button",null,"-");remove.type="button";remove.className="ensemble-icon";remove.title="Remove sub agent";remove.setAttribute("aria-label","Remove sub agent "+(index+1));remove.onclick=function(){subs.splice(index,1);drawSubs();};row.appendChild(remove);subList.appendChild(row);
    });
  }
  add.onclick=function(){subs.push((models[0]||{}).key);drawSubs();};drawSubs();
  var strategy=el("div");strategy.className="ensemble-field";strategy.appendChild(el("span",null,"Strategy"));var segments=el("div");segments.className="ensemble-segments";
  function modeButton(value,label){var button=el("button",null,label);button.type="button";button.onclick=function(){mode=value;paintModes();};button.paint=function(){button.setAttribute("data-active",String(mode===value));};segments.appendChild(button);return button;}
  var brainstorm=modeButton("brainstorm","Brainstorm"),debate=modeButton("debate","Debate");function paintModes(){brainstorm.paint();debate.paint();roundRow.style.display=mode==="debate"?"flex":"none";}strategy.appendChild(segments);box.appendChild(strategy);
  var roundRow=el("label");roundRow.className="ensemble-field";roundRow.appendChild(el("span",null,"Debate rounds"));var rounds=el("input");rounds.type="number";rounds.min="1";rounds.max="5";rounds.value=String(cfg.rounds||1);rounds.className="ensemble-number";roundRow.appendChild(rounds);box.appendChild(roundRow);paintModes();
  var info=el("div");info.className="ensemble-info";box.appendChild(info);
  var actions=el("div");actions.className="ensemble-actions";var disable=el("button",null,"Disable");disable.type="button";disable.className="ensemble-action";var apply=el("button",null,"Apply");apply.type="button";apply.className="ensemble-action ensemble-action-primary";actions.appendChild(disable);actions.appendChild(apply);box.appendChild(actions);
  function buildConfig(enabled){
    var leader=specFor(models,leaderSelect.value),instances=[];if(leader)instances.push({key:"leader:"+leader.key,harness:leader.harness,model:leader.model,label:leader.label});
    subs.forEach(function(key,index){var spec=specFor(models,key);if(spec)instances.push({key:"sub:"+(index+1)+":"+spec.key,harness:spec.harness,model:spec.model,label:spec.label});});
    return {enabled:enabled,mode:mode,rounds:parseInt(rounds.value||"1",10),leader:instances[0]&&instances[0].key,models:instances};
  }
  function save(enabled,button){
    var next=buildConfig(enabled);if(enabled&&next.models.length<2){info.style.color="#ff9ca5";info.textContent="Add at least one sub agent.";return;}
    button.disabled=true;window.codexEnsemble.set(next).then(function(result){var saved=result&&result.config||next;refreshEntries(saved);info.style.color="#8abf9f";info.textContent=enabled?"Applied to the next turn.":"Ensemble disabled.";button.disabled=false;}).catch(function(e){info.style.color="#ff9ca5";info.textContent=e.message||String(e);button.disabled=false;});
  }
  disable.onclick=function(){save(false,disable);};apply.onclick=function(){save(true,apply);};positionSubmenu(entry,box);
}
function openSubmenu(entry){
  if(activeEntry===entry&&activeSubmenu)return;closeSubmenu();activeEntry=entry;entry.setAttribute("aria-expanded","true");
  var box=el("div");box.id="__ensemble-submenu";box.className="ensemble-flyout";box.setAttribute("role","dialog");box.setAttribute("aria-label","Ensemble configuration");box.style.visibility="hidden";
  var head=el("div");head.className="ensemble-head";head.appendChild(el("span",null,"Ensemble"));head.firstChild.className="ensemble-title";var close=el("button",null,"x");close.type="button";close.className="ensemble-icon";close.title="Close";close.setAttribute("aria-label","Close");close.onclick=closeSubmenu;head.appendChild(close);box.appendChild(head);
  var status=el("div",null,"Loading models...");status.className="ensemble-info";box.appendChild(status);(document.body||document.documentElement).appendChild(box);activeSubmenu=box;positionSubmenu(entry,box);
  if(!window.codexEnsemble){status.textContent="Ensemble bridge unavailable";return;}
  window.codexEnsemble.get().then(function(cfg){return availableModels(cfg).then(function(models){if(activeSubmenu===box)renderSubmenu(box,status,cfg,models,entry);});}).catch(function(e){if(activeSubmenu===box)status.textContent=e.message||String(e);});
}
function installEntry(menu,sample){
  var host=sample.parentElement;if(!host||host.querySelector("[data-codex-ensemble-entry=true]"))return;
  var entry=sample.cloneNode(false);entry.removeAttribute("data-model-selected");entry.removeAttribute("id");entry.removeAttribute("aria-checked");entry.removeAttribute("aria-describedby");entry.removeAttribute("aria-selected");entry.removeAttribute("data-highlighted");entry.removeAttribute("data-state");entry.setAttribute("data-codex-ensemble-entry","true");entry.setAttribute("aria-haspopup","dialog");entry.setAttribute("aria-expanded","false");entry.setAttribute("tabindex","-1");entry.style.borderTop="1px solid var(--color-token-border-default,rgba(128,128,128,.25))";entry.style.marginTop="4px";entry.style.paddingTop="8px";entry.style.paddingBottom="8px";
  entry.setAttribute("role","menuitem");
  var content=el("span",{display:"flex",width:"100%",minWidth:"0",alignItems:"center",gap:"12px"});content.appendChild(el("span",{flex:"1",fontWeight:"500"},"Ensemble"));var summary=el("span",{color:"var(--color-token-text-tertiary,#999)",fontSize:"12px"},cachedConfig&&cachedConfig.enabled?((cachedConfig.models||[]).length+" agents"):"Off");summary.setAttribute("data-ensemble-summary","");content.appendChild(summary);content.appendChild(el("span",{fontSize:"17px",color:"var(--color-token-text-tertiary,#999)"},">"));entry.appendChild(content);
  entry.addEventListener("pointerenter",function(){openSubmenu(entry);});entry.addEventListener("mousedown",function(e){e.preventDefault();e.stopPropagation();});entry.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();openSubmenu(entry);});entry.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "||e.key==="ArrowRight"){e.preventDefault();openSubmenu(entry);}});host.appendChild(entry);
}
function scanMenus(){
  document.querySelectorAll("[data-model-selected]").forEach(function(sample){var menu=sample.closest("[role=menu]");if(menu)installEntry(menu,sample);});
}
function onMutations(records){
  for(var i=0;i<records.length;i++){
    if(records[i].type==="attributes"){scanMenus();return;}
    for(var j=0;j<records[i].addedNodes.length;j++){var node=records[i].addedNodes[j];if(node.nodeType===1&&(node.matches("[data-model-selected]")||node.querySelector("[data-model-selected]"))){scanMenus();return;}}
  }
}
function init(){
  var oldButton=document.getElementById("__ensemble-btn"),oldPanel=document.getElementById("__ensemble-panel");if(oldButton)oldButton.remove();if(oldPanel)oldPanel.remove();addStyles();scanMenus();
  new MutationObserver(onMutations).observe(document.body||document.documentElement,{attributes:true,attributeFilter:["data-model-selected"],childList:true,subtree:true});
  document.addEventListener("pointerdown",function(e){if(activeSubmenu&&!activeSubmenu.contains(e.target)&&(!activeEntry||!activeEntry.contains(e.target)))closeSubmenu();},true);
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&activeSubmenu)closeSubmenu();},true);
  if(window.codexEnsemble)window.codexEnsemble.get().then(refreshEntries).catch(function(){});
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
${RENDERER_END}
`;

function appendOnce(bundles, marker, injection, label) {
  let count = 0;
  for (const bundle of bundles) {
    let code = fs.readFileSync(bundle.path, "utf8");
    if (code.includes(marker)) {
      const endMarker = marker.slice(1).replace("_START__*/", "_END__*/;");
      const start = code.indexOf(marker);
      const end = code.indexOf(endMarker, start);
      if (end < 0) throw new Error(`${label} end marker missing in ${relPath(bundle.path)}`);
      code = code.slice(0, start) + injection + code.slice(end + endMarker.length);
      fs.writeFileSync(bundle.path, code);
      console.log(`  [ok] ${relPath(bundle.path)}: ${label} refreshed`);
    } else {
      fs.writeFileSync(bundle.path, code + injection);
      console.log(`  [ok] ${relPath(bundle.path)}: ${label} injected`);
    }
    count++;
  }
  return count;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const opts = platform ? { platform } : {};
  const mainBundles = [
    ...locateBundles({ dir: "build", pattern: /^main-.*\.js$/, all: true, ...opts }),
    ...locateBundles({ dir: "build", pattern: /^src-.*\.js$/, all: true, ...opts }),
  ];
  const ipc = appendOnce(mainBundles, IPC_START, IPC_INJECT, "ensemble IPC");
  const preload = appendOnce(locateBundles({ dir: "build", pattern: /^preload\.js$/, ...opts }), PRELOAD_START, PRELOAD_INJECT, "ensemble preload");
  const renderer = appendOnce(locateRendererEntry(opts), RENDERER_START, RENDERER_INJECT, "ensemble renderer");
  console.log(`  [done] ipc:${ipc} preload:${preload} renderer:${renderer}`);
  if (!ipc || !preload || !renderer) process.exit(1);
}

if (require.main === module) main();
module.exports = { IPC_INJECT, PRELOAD_INJECT, RENDERER_INJECT, locateRendererEntry };
