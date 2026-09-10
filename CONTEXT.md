# Banana Memory

The implementation baseline is `prd.md`. One local user owns one kernel and one LanceDB authority table.

- Project: a canonical existing workspace, or a session-only scope when binding is ambiguous.
- Source root: one original event. Retries and summaries cannot multiply evidence.
- Candidate: sourced but unverified model material; excluded from default recall.
- Memory: versioned material, never an instruction to the host.
- Control generation: incremented whenever maintenance changes current validity. Workers and delivery must recheck it.
- Intent: a one-use maintenance capability issued only for an exact top-level user hook command.
- Tombstone: a body-free identifier preventing deleted source replay.

Tests exercise Memory Service using a real local database and a controlled clock, model adapter fixtures plus real local evaluation, and the Claude host entrypoints, as specified in PRD section 12. No external tracker or remote is configured.
