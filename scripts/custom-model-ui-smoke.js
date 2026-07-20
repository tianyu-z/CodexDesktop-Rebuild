#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");
const { UI_INJECT } = require("./patch-custom-models");

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: true,
    width: 900,
    height: 800,
    webPreferences: { contextIsolation: false, sandbox: false },
  });
  const html = [
    "<style>",
    "body { margin: 0; background: #151515; color: #e8e8e8; font: 13px system-ui; }",
    ".composer { position: fixed; left: 280px; bottom: 80px; width: 340px; height: 64px; border: 1px solid #444; border-radius: 8px; }",
    ".portal { position: fixed; left: 300px; bottom: 150px; width: 300px; background: #202020; border: 1px solid #444; border-radius: 8px; padding: 8px; box-shadow: 0 12px 30px #0008; }",
    ".item { display: flex; align-items: center; width: 100%; min-height: 34px; padding: 6px 8px; color: #ddd; background: transparent; border: 0; border-radius: 4px; }",
    ".sr { position: absolute; width: 1px; height: 1px; overflow: hidden; }",
    "</style>",
    "<div class=\"composer\"></div>",
    "<div class=\"portal\"><div role=\"menu\"><div><div class=\"vertical-scroll-fade-mask\">",
    "<button class=\"sr\" role=\"menuitem\">Keyboard control</button>",
    "<button class=\"item\" role=\"menuitem\" data-model-selected=\"true\">GPT-5.6 Sol</button>",
    "<button class=\"item\" role=\"menuitem\">Claude Opus 4.8</button>",
    "</div></div></div></div>",
  ].join("");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const injection = await window.webContents.executeJavaScript(
    "(function(){try{(0,eval)(" + JSON.stringify(UI_INJECT) + ");return 'ok';}" +
    "catch(error){return 'ERROR: '+(error&&error.stack||error);}})()"
  );
  if (injection !== "ok") throw new Error(injection);
  const result = await window.webContents.executeJavaScript(
    "(async function(){" +
      "document.querySelector('[aria-label=\"Add custom model\"]').click();" +
      "await new Promise(function(resolve){setTimeout(resolve,50);});" +
      "return {" +
        "entry:document.querySelector('[data-cc-add-model]')?.innerText," +
        "entryRect:(function(){var r=document.querySelector('[aria-label=\"Add custom model\"]').getBoundingClientRect();return {width:r.width,height:r.height};})()," +
        "panel:Boolean(document.querySelector('#__cm-panel'))," +
        "buttons:[...document.querySelectorAll('#__cm-panel button')].map(function(button){return button.innerText;})" +
      "};" +
    "})()"
  );
  const screenshot = path.join(__dirname, "..", "out", "custom-model-menu-smoke.png");
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(screenshot, (await window.capturePage()).toPNG());
  window.destroy();
  console.log(JSON.stringify({ ...result, screenshot }, null, 2));
  app.quit();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
