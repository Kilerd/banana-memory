# Stable project identity and candidate synthesis

## Context

HTTP clients without roots created a new project per MCP session. Agent-supplied display labels could be identical while identities differed. Meanwhile all HTTP observations were candidates, but experience consolidation accepted only active episodes. Accumulation could not produce higher-level knowledge.

## Decision

Trusted local workspace resolution maps repository subdirectories and linked worktrees to the main checkout via Git's common directory. Actual workspace paths remain available for host file-boundary checks. Non-Git directories retain their realpath identity; unrelated clones are not merged by remote URL or label. Rootless sessions remain isolated and read-only: backend record/feedback return `workspace_required` with an actionable HTTP hint, preventing further session-project proliferation. Existing unbound projects remain visibly labelled. Codex's existing `codex-headers` helper transmits the canonical project root.

Existing projects move only through an explicit local CLI mapping under the service's single-writer lock, after operator backup. One atomic store commit retains record IDs, semantic versions, source roots, task/session identities, history and tombstones. Project aliases document previous ownership, while session bundles and maintenance credentials are invalidated. Conflicting environments, paused projects and pending purges block migration. Identical plans are idempotent.

Introduce `summary` separately from `experience`. Synthesis consumes only original fact/preference/episode records in candidate or active state. A deterministic bounded grouping uses existing compatible vectors, falling back to lexical similarity. Groups contain 3–6 related memories from at least two independent source roots. Derived observations do not count as independent roots. The generation model may abstain. Output requires an exact supporting quote from every supplied member. Paraphrased synthesis remains candidate evidence; verbatim quote validation proves provenance, not the truth of the model's interpretation.

Summaries stay project scoped and are never inputs to further synthesis or promoted by success feedback. Each stores member IDs/versions, full original member contexts, original event sources and relations. The worker runs after extraction/vector work, at most two groups per pass; jobs are keyed by policy and member versions, survive restart and retry at most three times. Completion, abstention and failures are inspectable. Publication checks source availability, member versions, project generation and pause state again after inference. Correction marks dependent summaries for review; source deletion removes summaries and jobs through the existing dependency/purge path.

## Consequences

HTTP Skill users can retrieve useful higher-level candidate notes without claiming direct-user authority. Conditional experience promotion retains its existing three-task/two-session verified outcome requirements. Model summaries still need verification; similarity grouping and a small local model may miss relationships or abstain. The first implementation adds one synthesis level and preserves original evidence rather than recursively summarizing summaries.
