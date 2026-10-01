/** Merge this feature into the installed app without replacing later fixes. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { replaceExactOnce } = require('./patch-agent-modes');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'b5c05db';

function patchSharedPicker(source) {
  const before = 'requestsAtom:XDr,nativeModelPicker:H,bothNativeModelPicker:';
  return replaceExactOnce(source, before, 'requestsAtom:XDr,nativeUI:{Button:aZ,Label:Tic,Dropdown:HI,PowerMenu:noc,Menu:qI,Check:EI},nativeModelPicker:H,bothNativeModelPicker:', 'shared Claude picker components');
}

function mergeInstalledSource(installed, relative) {
  let base = execFileSync('git', ['show', `${BASE}:${relative}`], { cwd: ROOT, encoding: 'utf8' });
  let updated = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  if (relative.endsWith('agent-modes-ui.js')) {
    // These installed fixes overlap our lines but are independent of effort.
    // Carry them into both merge inputs; all other overlaps fail for review.
    const preserve = source => {
      if (installed.includes('const DEFAULT_CLAUDE_MODEL')) {
        for (const expression of ['options.engineModel', 'state.models.claude']) source = source.replaceAll(`${expression} ?? 'default'`, `${expression} ?? DEFAULT_CLAUDE_MODEL`);
      }
      const activity = "    if (state?.claudeActivity !== undefined) values.claudeActivity = copy(state.claudeActivity);\n    if (state?.claudeRoleActivities !== undefined) values.claudeRoleActivities = copy(state.claudeRoleActivities);";
      if (installed.includes(activity)) source = source.replace('    if (state?.claudeSessionOptions !== undefined) values.claudeSessionOptions = copy(state.claudeSessionOptions);', line => `${line}\n${activity}`);
      const status = ", mode !== 'codex' && state.claudeActivity ? jsx.jsx(ClaudeRunStatus, { React, jsx, activity: state.claudeActivity }) : null";
      if (installed.includes(status)) source = source.replace(/jsx\.jsx\(CommandControls, \{ React, jsx, scope, threadId, hostId, cwd, manager(?:, nativeUI: props.nativeUI)? \}\)/, text => text + status);
      const runStatus = installed.indexOf('  function ClaudeRunStatus('), selector = installed.indexOf('  function Selector(props)');
      if (runStatus !== -1 && selector > runStatus) source = source.replace('  function Selector(props)', installed.slice(runStatus, selector) + '  function Selector(props)');
      return source;
    };
    base = preserve(base); updated = preserve(updated);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-effort-merge-'));
  try {
    const files = ['installed', 'base', 'updated'].map(name => path.join(dir, name));
    [installed, base, updated].forEach((text, index) => fs.writeFileSync(files[index], text));
    const result = spawnSync('git', ['merge-file', '-p', ...files], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Installed ${relative} has overlapping changes; review the merge before building. ${result.stderr}`);
    return result.stdout;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { mergeInstalledSource, patchSharedPicker };
