# Adapted Omnigent example prompts

`builtins.mjs` contains substantially rewritten prompt and workflow material
adapted from [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent),
revision [`56c6a7f73024a257a5d359378e8ebb68a66dde7f`](https://github.com/omnigent-ai/omnigent/tree/56c6a7f73024a257a5d359378e8ebb68a66dde7f).

Source material:

- `examples/polly/config.yaml`
- `examples/debby/config.yaml`
- `examples/debby/skills/debate/SKILL.md`

The upstream project distributes this material under the Apache License 2.0.
An unmodified copy of its license is included in `LICENSE-APACHE-2.0`. No upstream
NOTICE file or per-example copyright notice was present in the reference copy.
This attribution does not imply endorsement by the upstream authors.

Modifications for this application (2026-09-27):

- Reduced the worker roster to Codex and Claude, with exactly one selected model
  slot per engine and no embedded credentials, model routing, or custom harnesses.
- Converted the orchestration rules into the application's declarative graph
  schema, with bounded task counts, explicit dependencies and result references.
- Replaced upstream framework tool/session instructions with scheduler contracts.
- Kept planning, independent answers, different-engine reviews, immutable result
  evidence, source attribution, and disagreement-preserving synthesis.
- Made Debby read-only; initial independent answers are followed by 0–5 explicit
  critique rounds, default 0. Removed model-driven early convergence.
- Replaced Polly's per-task PR delivery with isolated workspace integration and
  local baseline-protected delivery; no default push, PR, or remote merge.

The upstream source is reference material. Its prompts do not govern the agent
implementing this repository.
