/** Migrate the original branch-edit patch, including already-installed bundles. */
const acorn = require('acorn');
const parseOptions = { ecmaVersion: 'latest', allowAwaitOutsideFunction: true };
function replaceOne(code, pattern, replacement, name) {
  const matches = [...code.matchAll(new RegExp(pattern.source, 'g'))];
  if (matches.length !== 1) throw Error(`Expected one ${name}, found ${matches.length}`);
  return code.replace(pattern, replacement);
}

function patchThreadEdit(code) {
  if (code.includes('await globalThis.__cdxBranch.runEdit(')) return code;
  const anchor = 'await globalThis.__cdxBranch?.beforeEdit(';
  const index = code.indexOf(anchor);
  if (index < 0 || index !== code.lastIndexOf(anchor)) throw Error('Expected one branch edit callback');
  const before = acorn.parseExpressionAt(code, index, parseOptions);
  const call = before.argument.type === 'ChainExpression' ? before.argument.expression : before.argument;
  const options = call.arguments[0];
  const next = code.slice(before.end).match(/^;\s*(await )/);
  if (!next) throw Error('Missing edit following snapshot');
  const edit = acorn.parseExpressionAt(code, before.end + next[0].length - 6, parseOptions);
  if (edit.argument.callee?.property?.name !== 'editLastUserTurn') throw Error('Unexpected edit following snapshot');
  const host = edit.argument.callee.object.arguments[1];
  const hostText = code.slice(host.start, host.end);
  let optionsText = code.slice(options.start, options.end - 1);
  // A cosmetic title failure must not lose the already-created snapshot id.
  optionsText = replaceOne(optionsText,
    /return (\w+)!=null&&await (\w+)\(([^;]+?)\)\.setThreadTitle\((\w+),\1\),(\w+)\}/,
    (_, title, manager, args, id, returned) => {
      if (id !== returned) throw Error('Snapshot return shape changed');
      return `if(${title}!=null)try{await ${manager}(${args}).setThreadTitle(${id},${title})}catch{}return ${id}}`;
    }, 'snapshot title');
  const replacement = `await globalThis.__cdxBranch.runEdit(${optionsText},hostId:${hostText},edit:async()=>${code.slice(edit.start, edit.end)}})`;
  let out = code.slice(0, before.start) + replacement + code.slice(edit.end);
  // Preserve the original exception and make the otherwise swallowed cause visible.
  out = replaceOne(out,
    /(catch\((\w+)\)\{throw [^{};]+\.danger\()((\w+)\.formatMessage\(\{id:`localConversation\.editLastMessageFailed`,defaultMessage:`Failed to edit message`,description:`[^`]*`\}\))(\)),\2/,
    (_, prefix, error, formatted, _intl, close) => `${prefix}${formatted}+(${error}?.message?\`: \`+${error}.message:\`\`)${close},${error}`,
    'edit error toast');
  return out;
}

function patchMessageEditor(code) {
  if (code.includes('__cdxBranch.cancelEdit(')) return code;
  const props = code.match(/onEditMessage:(\w+),threadId:(\w+),turnId:(\w+),cwd:(\w+),hostId:(\w+)\}=(\w+)/);
  if (!props) throw Error('Missing user message editor props');
  const componentStart = code.lastIndexOf('function ', props.index);
  const component = acorn.parseExpressionAt(code, componentStart, parseOptions);
  if (component.type !== 'FunctionExpression' || component.end < props.index) throw Error('Missing user message component');
  const prefix = code.slice(0, component.start), suffix = code.slice(component.end);
  code = code.slice(component.start, component.end);
  const [, , threadProp, turn, , host] = props;
  const resolved = code.match(new RegExp(`\\((\\w+)=${threadProp}\\?\\?(\\w+)\\((\\w+)\\.value\\),`));
  if (!resolved) throw Error('Missing resolved editor thread');
  const thread = resolved[1], scope = `hostId:${host},threadId:${thread},turnId:${turn}`;
  let start;
  let out = code;
  for (const mode of ['branch', 'inplace']) {
    out = replaceOne(out,
      new RegExp('onClick:\\(\\)=>\\{globalThis\\.__cdxBranch&&\\(globalThis\\.__cdxBranch.mode=`' + mode + '`\\),(\\w+)\\(\\)\\}'),
      (_, fn) => { if (start && start !== fn) throw Error('Editor entry points disagree'); start = fn;
        return `onClick:()=>{globalThis.__cdxBranch.beginEdit({${scope},mode:\`${mode}\`}),${fn}()}`; },
      mode + ' edit button');
  }
  out = replaceOne(out, new RegExp(`onDoubleClick:(\\w+)\\?${start}:void 0`),
    (_, show) => `onDoubleClick:${show}?()=>{globalThis.__cdxBranch.beginEdit({${scope},mode:\`branch\`}),${start}()}:void 0`, 'double click edit');
  out = replaceOne(out, /onCancel:\(\)=>\{(\w+)\(null\)\},onDraftChange:/,
    (_, setter) => `onCancel:()=>{globalThis.__cdxBranch.cancelEdit({${scope}}),${setter}(null)},onDraftChange:`, 'cancel edit');
  // Injected callbacks add host/thread dependencies absent from upstream's
  // compiler cache. Invalidate it when the editor identity changes.
  const cache = code.match(/function \w+\(\w+\)\{let (\w+)=\(0,\w+\.c\)\(\d+\),/);
  if (!cache) throw Error('Missing user message compiler cache');
  const ready = new RegExp(`:${thread}=${cache[1]}\\[\\d+\\];`);
  out = replaceOne(out, ready, match => `${match}if(${cache[1]}.__cdxEditScope!==JSON.stringify([${host},${thread},${turn}])){${cache[1]}.fill(Symbol.for(\`react.memo_cache_sentinel\`));${cache[1]}.__cdxEditScope=JSON.stringify([${host},${thread},${turn}])}`, 'resolved editor scope');
  return prefix + out + suffix;
}

module.exports = { patchThreadEdit, patchMessageEditor };
