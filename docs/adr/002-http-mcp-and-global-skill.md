# 002 — Foreground HTTP MCP and global Skill

## Status

Accepted for the standard installation path. The existing Claude plugin remains an optional enhanced integration.

## Decision

Run the memory database, queue and local models in one foreground process started with `banana-memory start`. Expose tools through an authenticated Streamable HTTP MCP endpoint bound to `127.0.0.1`. Distribute a standalone `banana-memory` Agent Skill through the standard Skills CLI and register the MCP endpoint once at Claude Code user scope.

Resolve project identity from the MCP client's `roots/list` response and canonicalize the local file path on the server. Do not accept workspace or project identifiers in tool arguments. When no trusted file root is available, bind an isolated session scope.

The standard HTTP mode has no lifecycle hooks. Its Skill initiates recall and records durable observations at meaningful milestones. Such observations retain model-mediated candidate status. HTTP sessions may retrieve those labelled candidates, while the strict plugin mode continues to exclude them from default recall and retains hook-issued capabilities for user-authorized maintenance.

## Consequences

The normal setup becomes three familiar operations: start an npm-delivered foreground server, install one global Skill, and add one HTTP MCP server. Multiple clients and sessions share a single database and model runtime.

HTTP mode does not promise lossless prompt or tool-event capture, automatic context injection before every prompt, or cryptographically verified top-level user intent. Destructive maintenance remains outside the standard MCP tool set until a trusted confirmation channel exists. The Claude plugin remains available when those stronger host semantics are required.

The local endpoint uses a persistent random bearer token, loopback Host checks and local Origin validation. The token and database directory are accessible only to the current operating-system user.
