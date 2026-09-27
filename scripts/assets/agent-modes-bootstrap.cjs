// Loaded before the upstream desktop bootstrap, only in the rebuilt app.
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');
const runtime = path.join(process.resourcesPath, 'agent-modes');
const config = JSON.parse(fs.readFileSync(path.join(runtime, 'build.json'), 'utf8'));
process.env.CDX_ENGINE_APP_NAME = config.appName;
process.env.CDX_REAL_CODEX = path.join(process.resourcesPath, 'codex');
process.env.CDX_ENGINE_STORE = path.join(app.getPath('appData'), config.appName, 'engine-conversations');
process.env.CODEX_CLI_PATH = path.join(runtime, 'codex-gateway');
// CODEX_CLI_PATH selects the local stdio transport. Remote hosts retain their
// own configured transport and CLI; no process-wide FORCE_CLI override is used.
