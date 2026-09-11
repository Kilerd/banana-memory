# 003 — Local dashboard and memory scope

## Status

Accepted.

## Decision

Serve a read-only management page from the foreground HTTP process. The HTML shell is public on loopback and contains no memory data. Its data API requires the same persistent bearer token as MCP. The CLI places that token in the UI URL fragment; the page moves it into `sessionStorage`, removes the fragment, and sends it only in the Authorization header.

The dashboard exposes each memory's stored and effective state, time weight, applicability, evidence, version history, source relations, consolidation members, and derived children. It does not add a second database or write path.

New memories carry either `project` or `global` scope. Existing records without the field remain project scoped. Facts and preferences may be global only when their source evidence explicitly states user-wide or cross-project applicability. Episodes and consolidated experiences are always project scoped. A global memory remains physically owned by its source project so deletion, history, and provenance stay intact.

Recall considers memories owned by the current project plus global memories from other projects. Final state, source, condition, and version checks still apply, and current-project memories receive a small ranking preference. Model-mediated HTTP records retain candidate status even when global.

## Consequences

One running service can show the complete local memory collection and explain aging, merging, and derivation. Users can carry explicit preferences or rules across repositories without merging project-specific outcomes. A global memory with environment conditions may be ineligible in projects whose current environment does not satisfy those conditions.
