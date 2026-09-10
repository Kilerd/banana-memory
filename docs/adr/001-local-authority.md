# ADR 001: Local memory authority and release boundary

Status: accepted for the local trial, 2026-09-10.

Use Node.js 22.23.1, the released LanceDB OSS SDK 0.38.0, and a Claude Code plugin containing hooks, MCP and Skill. Validate against Claude Code 2.1.231 on macOS 26.5.2 / Apple Silicon. The available machine is an Apple M4 Pro with 48 GiB RAM; this does not establish 16 GB support.

One local kernel holds a renewing owner-only lock and one LanceDB authority table. Events, memory versions, source edges, jobs, controls, intent capabilities, bundles and tombstones publish together through a same-table atomic merge. In-memory projections and indexes are rebuildable caches; there is no second database. Native queries and maintenance are serialized. Cached vectors never override final scope, source, time, environment or control validation.

Correction reserves its memory identity against delayed model output and queues a version-checked vector backfill. Deletion first publishes body-free tombstones and withdrawn records, then compacts and removes physical snapshots, tags, branches and stale indexes. Interrupted cleanup persists a resumption record. Captured outputs and MCP summaries carry original dependencies rather than counting as new evidence roots.

Generated extraction is source-selective rather than free-form summarization: constrained JSON fields and verbatim evidence preserve the source's numbers, negation and exceptions. Similar episodes may be grouped, but only verified independent original tasks can promote conditional experience. This intentionally favors traceability over broad generalization.

The local installer and archive are real and testable without inventing a registry package or remote repository. The static page is bundled as installation documentation and served locally. Public site/application release remains gated by the outstanding PRD acceptance evidence; it is not automatically deployed from this implementation task.
