# Engine templates, schema versions 1 and 2

This directory contains declarative templates and local revision storage. It does
not start models, execute code, grant permissions, or implement the scheduler.
The scheduler must enforce the contracts below before reporting an operation as
successful. Each role resolves its model from the conversation's role override,
then the template role's optional `model`, then `models.codex` or `models.claude`.
An explicit null model selects the engine's native default. A role cannot declare a provider,
environment, credential, harness path, command, tool process, or approval policy.
Prompt text is supplementary instruction data, never an executable expression.

## Public API

```js
import {
  validateTemplate, resolveParameters, validateTaskPlan,
  validateId, validateRevision, templateContentHash,
  TemplateValidationError, SCHEMA_VERSION, DEFAULT_LIMITS,
} from './schema.mjs';
import { BUILTIN_TEMPLATES } from './builtins.mjs';
import { TemplateStore } from './store.mjs';

const store = new TemplateStore(absoluteEngineTemplatesDirectory);
store.list();                            // full current snapshots, sorted by ID
store.read('debby');                      // snapshot or null
store.read('my-template', 1);              // historical snapshot or null
store.save(template);                     // new snapshot, with assigned revision
store.remove('my-template');               // true if deleted, false if absent/deleted
store.import(yamlOrJsonText);              // parse, validate, save; never run
store.export('my-template', 1, 'yaml');     // string; format defaults to yaml
store.export('my-template', undefined, 'json');
```

All methods are synchronous. Returned values are ordinary serializable objects
with no mutable connection to saved state. `BUILTIN_TEMPLATES` is deeply frozen.
`validateTemplate(input)` returns a fresh normalized snapshot; it does not mutate
input. `resolveParameters(template, values = {})` validates overrides and fills
defaults. Unknown parameter names, wrong types, or out-of-range values fail.
`validateTaskPlan(input, {maxTasks = 8} = {})` validates model-generated plans.
`TemplateValidationError` has `name`, `path` and a message beginning with the field
path, such as `$.steps[1].inputs[0]`. `validateId` and `validateRevision` return the
validated input or throw. `templateContentHash` expects an already normalized
template and returns its canonical SHA-256 digest.

## Document fields

Only the fields below are accepted. Omission activates documented defaults;
explicit `null` does not. Role, parameter, step, task and alias IDs match
`^[a-z][a-z0-9_-]{0,63}$`; reserved reference/prototype names are rejected.
Step IDs are unique within a scope. Reusing `codex` in distinct parallel/repeat
scopes is intentional. Roles and parameters have independent namespaces.

| Field | Schema |
| --- | --- |
| `schemaVersion` | Required, `1` or `2`. New role models, same-engine graphs, parameter enums and hosted debates normalize to `2`. |
| `id` | Required stable ID; never a file path. `polly` and `debby` are reserved built-in IDs. |
| `revision` | Positive safe integer; omitted input defaults to `1`. Assigned locally on save. |
| `name` | Nonempty string, at most 200 characters. |
| `description` | Required string, may be empty, at most 5,000 characters. |
| `roles` | Object with 1–64 named roles, each `{engine, prompt, access, session, model?, permissionMode?}`. |
| `parameters` | Named typed definitions; defaults to `{}`, maximum 32 definitions. |
| `limits` | Defaults to `{concurrency:2,tasks:8,rounds:2}`; partial objects fill defaults. |
| `steps` | Nonempty root scope; DAG rules below. |
| `output` | Exactly `{sources:string[], final:string, format:'markdown'|'text'|'json'}`. |
| `builtin` | Optional boolean presentation metadata; normalized to `false` when absent. User saves force `false`. |
| `contentHash` | Optional 64-character lowercase SHA-256 metadata; recomputed by validation/save. |

Role `engine` is `codex` or `claude`, `access` is `read` or `write`, `session` is
`reuse` or `fresh`, and `prompt` is a nonempty string up to 100,000 characters.
Access is a ceiling intersected with host/user policy. The scheduler/harness must
actually enforce read-only roles. `reuse` allows a role's separate native session
to resume under the same template revision and workspace; `fresh` requires a new
role session. Sessions are not shared between roles or concurrent tasks. Engine,
model and prompt are part of binding identity. Top-level `roleOverrides` on
conversation/turn selection accepts existing role IDs mapped to `{engine?,model?,prompt?,permissionMode?}`.
For Claude roles, `permissionMode` accepts `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, or `dontAsk`; it defaults to `default`. The native harness decides effective policy, while `access: read` continues to restrict the tool set. A permission override does not affect Codex. Overrides cannot change access or session policy. Omitted overrides preserve selection,
`{}` clears them, and changing template resets omitted overrides. The effective
configuration is frozen for retry and resume.

Parameter definitions are `{type,default,min?,max?,description?,enum?}`. Types are
`integer`, `number`, `boolean` or `string`. Numeric definitions require finite
`min` and `max`; integer bounds/defaults must be safe integers. String/boolean
definitions reject numeric bounds. String defaults/values allow up to 10,000
characters. Descriptions allow up to 2,000. No coercion occurs.

Limits are integer ceilings: `concurrency` 1–4 active native runs across the
whole template, `tasks` 1–32 dynamic tasks per plan, and `rounds` 0–10 per repeat
or repair loop. Nested containers do not each receive an independent concurrency
budget. The template graph allows at most 256 steps, 128 per scope, and 8 nested
container levels. Graphs may use only Codex, only Claude or both engines;
different roles may select identical or different models. Polly's dynamic
execution and opposite-engine review contracts still require their declared topology.

## References, dependencies and results

All steps have `id`, `type`, and optional `dependsOn:string[]` (normalized to
`[]`). Dependencies name siblings in the same scope. Missing/duplicate dependencies
and cycles fail. All steps in a scope are scheduled, once their dependencies
succeed, subject to the global concurrency limit. Array order is not a dependency.
Failures block dependent work; they do not produce a successful empty value.

`inputs` contains explicit reference strings, not text interpolation or code.
Built-in references are `request` (the user input snapshot), `history` (the public
history snapshot), and `parameters.<name>`. A leaf step exports its full result at
its ID (`draft`). A parallel group also exports descendants (`answers.codex`).
Step results can be used only when their producer is an explicit or transitive
dependency. Containers inherit the references made available by their own
dependencies. Local IDs cannot shadow visible outer result names. Siblings cannot
read unfinished peer results. `previousRound.<alias>` exists only in repeat bodies.

References resolve to complete runtime result envelopes, retaining attribution
and original output. Arbitrary property lookup such as `draft.text` is rejected.
Special supported exports are listed below. `output.sources` must name existing
root exports; `output.final` must name one of those sources. The `format` is a
presentation contract and does not instruct the scheduler to execute returned
text. Result envelopes and event/provenance fields are runtime-owned.

## Step schemas and scheduler contract

The schemas below are exact additional fields beyond `id`, `type`, `dependsOn`.
`Bound(min,max)` means an integer in that range or `{parameter:'name'}`, where
the declared integer parameter's entire range fits. The scheduler calls
`resolveParameters` once per turn, freezes those values, and resolves bounds
against them. No expressions or conditions are interpreted.

| Type | Fields | Meaning and exports |
| --- | --- | --- |
| `run` | `role:string`, `inputs:string[]`, optional `prompt:string` | One native role invocation. Step prompt appends to the role instructions. Exports the complete role result at its ID. A write role requires isolated workspace handling; the template cannot select an arbitrary writable directory. |
| `synthesize` | Same as `run` | Read-only role combines the declared sources using its independently resolved model. Same export shape as `run`. |
| `hostedDebate` | `participants:{alias:roleId,alias:roleId}`, `host:roleId`, `inputs:string[]`, `count:Bound(0,limits.rounds)`, `mode:'per-round'|'final-only'|{parameter:string}` | Three distinct read roles. Independent answers, bounded critique rounds and final synthesis; per-round mode validates host decisions and may stop early. Exports participant aliases, `sources` and `assessments`. |
| `parallel` | `steps:Step[]` | Nested DAG with ready children eligible concurrently. Completes after all children. Exports an object keyed by child IDs and each child's supported descendant references. |
| `repeat` | `count:Bound(0,limits.rounds)`, `initial:{alias:reference}`, `steps:Step[]`, `yields:{alias:localReference}` | Run a nested DAG exactly `count` times; no model-controlled early convergence. Exports an object keyed by aliases and `<id>.<alias>`. See snapshot rules below. |
| `planTasks` | `role:string`, `inputs:string[]`, optional `prompt:string`, optional `maxTasks:Bound(1,limits.tasks)` (default `limits.tasks`) | Read-only planner returns the task-plan JSON schema below. The scheduler validates it before any tasks launch. Exports validated `{tasks:[...]}` at its ID and its task list at `<id>.tasks`. |
| `executeTasks` | `plan:reference`, `roles:{codex:roleId,claude:roleId}`, `workspace:'isolated'` | `plan` must be a completed `planTasks` result. Role engines must match the map keys. Dispatch validated tasks using their declared engines, dependencies, file ownership and purpose. Preserve task result/artifact ownership. Exports a task-result envelope and `<id>.tasks`. |
| `crossReview` | `target:reference`, `reviewers:{codex?:roleId,claude?:roleId}`, optional `maxRepairs:Bound(0,limits.rounds)` (default `min(2,limits.rounds)`), conditional `workspace:'integration'` | `target` must be a completed `run` or `executeTasks` result. Reviewer keys are **implementer engines**: `codex` must map to a Claude read role and vice versa. Every possible target engine requires a reviewer. Exports the review envelope, `<id>.reviews` and `<id>.tasks`; task targets also export `<id>.integration`. |

`inputs` arrays are nonempty. `synthesize` and `planTasks` roles must have read
access. `executeTasks` declares both engine slots; a plan need not contain an equal
number of tasks for them. Reviewers receive immutable diff/result snapshots and
acceptance criteria, never the mutable implementer workspace. Their structured
verdict is `{passed:boolean,issues:[{message:string,path?:string}]}`. The runtime
validates that verdict and records the original implementation engine separately
from reviewer provenance. Repairs go back to the original implementer and create
a new immutable artifact/review attempt. `maxRepairs:0` still permits the initial
review and permits no repairs.

For `executeTasks` targets, `crossReview.workspace` is required and means:
review each task with the opposite engine, integrate passing implementation
artifacts in dependency order in an isolated integration workspace, verify the
integration, and preserve evidence/status and delivery information in
`result.integration`. Integration conflicts consume the same bounded repair
contract and require new cross-review. Applying verified results to the original
workspace must protect the starting baseline and user index. Read-only task
purposes remain read-only even when mapped to a write-capable worker role.
For direct `run` targets, `workspace` is absent; integration is not implied.
Export names are schema guarantees, not claims that this data-only module has
implemented workspace operations. The scheduler owns integration envelope
fields, including artifacts, checks, status and application outcome.

Repeat `initial` and `yields` must have the exact same nonempty alias set.
`initial` resolves against the repeat's completed outer dependencies. At round
1, `previousRound.alias` holds that initial result; round N receives only the
finished round N−1 snapshot. Complete the whole nested DAG before atomically
replacing that snapshot with `yields`, which resolves against local exports.
Nested repeats shadow only the `previousRound` namespace. At `count:0`, there
are no body invocations and the aliases yield `initial` unchanged. A repeat's
aliases are opaque values; they cannot masquerade as a `planTasks` or review
target to bypass producer-type checks.

Debby r2 uses `hostedDebate` with `participant_a`, `participant_b` and `host`.
Defaults are Codex, Claude and Claude; each can be overridden independently.
`rounds` defaults to 2 and allows 0–5; `host_mode` defaults to `per-round`.
Host assessments must be `{continue:boolean,guidance:string}`; invalid output
blocks the step and can be retried. Participant rounds consume immutable prior
outputs and host guidance. `final-only` executes the configured number of rounds
before synthesis. Debby r1 remains readable for historical workflows.
Polly uses Claude planning, isolated dynamic execution, opposite-engine
review/integration with at most 2 repairs, and Claude synthesis. Custom templates
can rearrange/compose these primitives; no workflow is selected by template name.

## Planner JSON

```json
{
  "tasks": [
    {
      "id": "api",
      "description": "Implement the requested endpoint",
      "engine": "codex",
      "purpose": "implement",
      "dependsOn": [],
      "files": ["src/api/**"],
      "acceptance": ["Endpoint tests pass"]
    }
  ]
}
```

Every field above is required, and extra fields are rejected. Purposes are
`implement`, `review`, or `explore`. Task IDs are unique; dependencies form a DAG.
An explicit `review` task requires target dependencies, each owned by the opposite
engine. `files` is a nonempty list of project-relative POSIX file scopes (plain
paths or glob patterns), never shell commands; absolute paths, backslashes,
colons, NUL, empty segments and `.`/`..` segments fail. The scheduler resolves
scopes beneath the workspace and serializes overlapping writes. `acceptance` is
a nonempty list of human-readable criteria, never executable command strings.
The schema permits 1–`maxTasks` tasks, 1–128 file scopes per task and 1–32 criteria.

## Revision storage and import

User snapshots are `<directory>/<id>/revisions/<revision>.json`. The atomically
replaced `<id>/current.json` pointer is `{revision,deleted}`. Each save creates
a new snapshot, even if its content is unchanged. The canonical content hash
sorts object keys, preserves array order, and excludes `revision`, `builtin`
and `contentHash`, so identical content has the same hash across revisions.
Reads revalidate schema, ID, revision and content hash before returning data.
Invalid saves cannot replace a valid current pointer.

For an existing ID, a supplied `revision` is an optimistic concurrency token and
must match the current pointer, including a deleted pointer. Omit it to append
without an expected revision. New IDs start at local revision 1 irrespective of
copied/imported source metadata; changing a built-in copy's ID is sufficient.
Removing a user template creates a tombstone and keeps every historical file.
Re-creating its ID increments the latest revision. Missing IDs return `null` from
`read` and `false` from `remove`; attempts to save/delete built-in IDs throw.
Shipped built-in revisions are immutable; executions must also retain
their full template snapshot to survive future built-in package upgrades.

Writes use fsynced temporary JSON files and atomic renames. The application must
hold the gateway's single-owner process lock for this storage directory; multiple
independent processes may not write it concurrently. Synchronous calls within
that owner are serialized, including calls through separate `TemplateStore`
instances, and stale revision tokens fail before writing a snapshot. There is no
additional persistent template write lock to survive a process crash. A crash
between snapshot and pointer writes may leave an unpointed immutable snapshot;
later revision numbers skip it. Paths below the configured trusted storage root
reject symlinks and traversal. The application must supply its own storage
directory, not one from a template.

Imports accept one YAML or JSON document up to 2 MiB using the YAML core schema.
Explicit tags, aliases/anchors, duplicate keys, non-string keys, multiple
documents and non-JSON values are rejected. Upstream Omnigent bundles containing
`executor`, `tools`, `os_env`, `guardrails`, `spawn` or `spec_version` are rejected
with their field path; no fields are silently stripped. Exports include metadata
and default to readable YAML. Neither import nor export runs any task.

See [NOTICE.md](NOTICE.md) and [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) for adapted
upstream material.
