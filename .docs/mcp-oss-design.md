# OSS MCP Design For Docmost

## Purpose

This document defines a repository-fit design for bringing MCP support into Docmost OSS.

The immediate goal is to expose a secure MCP server for AI assistants using delegated API-key authentication with explicit per-space access.

This design is intentionally narrower than a full enterprise feature port. It is optimized to slot into the existing OSS codebase with minimal duplication of business rules and minimal dependence on EE-only paths.

## Current Repository Reality

The design must match the codebase that already exists.

Observed facts:

- The backend is NestJS/Fastify under `apps/server/src`.
- `main.ts` excludes `mcp` from the global `/api` prefix, which strongly indicates the MCP transport should live at `/mcp`.
- The repo already contains an `api_keys` migration in OSS: `apps/server/src/database/migrations/20250912T101500-api-keys.ts`.
- Generated DB types already include `ApiKeys` in `apps/server/src/database/types/db.d.ts`.
- `JwtStrategy` supports `JwtType.API_KEY` in type shape, but the actual validation path dynamically requires an EE API key service and fails in OSS.
- `WorkspaceService` currently license-gates `mcpEnabled`, so OSS MCP enablement must explicitly remove or adjust that gating.
- The client already has EE-only MCP/settings and API key UI hints, but OSS-ready shared UI does not yet exist.
- `AuditContext` already supports `actorType: 'api_key'`, which means attribution should extend existing audit plumbing rather than invent a separate model.

## Problem Statement

Docmost OSS currently has partial API-key and MCP-related plumbing, but not a usable OSS-safe implementation.

The missing pieces are:

- OSS-native API key validation
- explicit per-space grants
- delegated authorization bounded by the creator's current access
- a transport-safe MCP module
- OSS-safe management UI/routes

## Product Goals

The first OSS MCP release should satisfy these goals:

- Authentication is done with API keys.
- API keys are denied all space access by default.
- Access is granted explicitly per space.
- Each space grant is `read_only` or `read_write`.
- The API key can never exceed the creating user's current authority.
- If the creator loses access, the key loses access immediately for practical purposes.
- Page-level restrictions must still apply.
- The implementation should reuse existing Docmost page/space/comment logic instead of duplicating authorization rules inside MCP handlers.
- The initial OSS launch should favor a smaller secure tool set over broad surface area.

## Non-Goals For Initial OSS Launch

The first OSS release should not try to solve every possible MCP feature.

Out of scope for initial release:

- service-account-style independent identities
- workspace-wide implicit access grants
- broad workspace directory exposure
- high-risk cross-space structural tools by default
- full audit-viewer UI redesign
- a transport design that depends on EE-only framework pieces

## Core Design Principle

API keys are delegated credentials, not standalone actors.

An API key only narrows the authority of the human creator. It never creates authority on its own.

For any request, effective permission is the intersection of:

- valid active key
- explicit space grant
- requested action type
- creator's current access
- existing page/comment restrictions

In other words:

`effective_permission = min(key_grant, creator_current_permission, downstream_resource_rules)`

## Permission Model

## Space grant scopes

Each key-space relationship is one of:

- `read_only`
- `read_write`

## Creator ceiling

Creator access is authoritative in real time.

Examples:

- key `read_write` + creator `reader` => effective read only
- key `read_only` + creator `writer` => effective read only
- key valid + creator removed from space => no access
- key valid + creator blocked by page restriction => no access to that page

## Capability simplification

For MCP, a minimal capability model is sufficient:

- `none`
- `read`
- `write`

Map current space roles to MCP capability:

- `reader` -> `read`
- `writer` -> `write`
- `admin` -> `write` for initial MCP tooling unless a specific tool requires admin-only behavior

This avoids over-designing an MCP-specific permission hierarchy that does not exist in the current app.

## Default deny

No space access is inherited from:

- workspace membership alone
- creator ownership alone
- historic access at creation time
- workspace defaults

Only explicit grants count.

## Page restriction rule

Space grants are necessary but not sufficient.

The MCP layer must never become a bypass around `PageAccessService` or equivalent current domain logic.

## Architecture Overview

The design adds two first-class OSS modules:

- `apps/server/src/core/api-key`
- `apps/server/src/integrations/mcp`

It also adds supporting repo/migration/audit/throttle integration.

## `ApiKeyModule`

Responsibilities:

- create keys
- list keys
- update metadata and grants
- revoke keys
- validate opaque bearer tokens
- load grants
- construct the MCP principal
- throttle `last_used_at` updates

This module is an OSS business capability and belongs under `core`, not hidden behind `ee`.

## `McpModule`

Responsibilities:

- mount transport at `/mcp`
- authenticate requests using API keys
- expose tools/resources/prompts
- build request-scoped execution context
- delegate into current domain services
- normalize protocol-safe errors
- apply truncation and throttling

This belongs under `integrations` because it is a protocol/interface layer over existing domains.

## Why split `core/api-key` from `integrations/mcp`

- API keys may later support non-MCP automations.
- MCP should not own persistence or lifecycle for credentials.
- This mirrors the repo's existing pattern of keeping product capability and integration surface separate.

## Authentication Design

## Opaque token format

Use:

- `dmk_<publicId>_<secret>_<checksum>`

Where:

- `publicId` is non-secret and used for lookup
- `secret` is high-entropy random material shown once
- `checksum` is a short HMAC-derived fast-fail suffix

## Why opaque tokens, not JWTs, for initial MCP

The repo already has JWT payload types for API keys, but the current working validation path is EE-bound.

For OSS MCP, opaque tokens are preferable because they:

- avoid coupling MCP auth to the existing browser/session JWT flow
- support immediate revocation checks naturally
- avoid confusion between user sessions and delegated machine credentials
- fit a dedicated guard/service model cleanly

## Dedicated MCP auth path

Initial OSS MCP should use a dedicated auth guard/service, not the standard JWT guard.

Reason:

- MCP traffic is not a browser session
- the token type is opaque, not a user JWT
- MCP should not inherit unrelated user-session assumptions

`JwtStrategy` cleanup can happen separately for compatibility, but should not define the transport design.

## Storage Design

## Existing table reuse

The repo already has `api_keys`. The design must extend it.

Required additional fields:

- `public_id`
- `secret_hash`
- `description`
- `status`
- `revoked_at`
- `revoked_by_user_id`

Existing fields to keep using:

- `id`
- `creator_id`
- `workspace_id`
- `name`
- `expires_at`
- `last_used_at`
- `created_at`
- `updated_at`
- `deleted_at`

## Grant table

Use a separate `api_key_space_grants` table rather than JSON-in-row storage.

Why:

- explicit auditability
- easier UI editing
- simple uniqueness rules
- simple joins for access resolution

## Transport Design

## Endpoint

Mount MCP at `/mcp`.

This is the correct default because `main.ts` already excludes `mcp` from the `/api` prefix.

## Response envelope compatibility

The standard app API wraps responses via `TransformHttpResponseInterceptor`.

MCP transport may require raw protocol envelopes. Therefore, MCP routes must explicitly bypass or avoid the standard API response wrapper if required by the chosen SDK/transport.

This is a design-critical requirement, not an implementation detail to discover late.

## Transport replaceability

Business rules must not be tied to a specific SDK.

The design should isolate:

- transport/controller concerns
- registry/descriptor concerns
- auth concerns
- authorization concerns
- domain delegation

So that the underlying MCP transport implementation can be changed without rewriting authorization and tool logic.

## Request Lifecycle

1. request hits `/mcp`
2. MCP auth guard extracts bearer token
3. `ApiKeyService` validates token and loads grants
4. MCP principal is attached to the request
5. registry resolves target tool
6. authorization service computes effective capability
7. context factory builds creator-backed execution context
8. existing domain services perform the operation
9. result is truncated/sanitized if needed
10. audit event is recorded
11. protocol response is returned

## Domain Delegation Rule

The MCP layer must stay thin.

It should not:

- reimplement page visibility
- reimplement comment edit rules
- duplicate space membership resolution
- create a parallel page tree engine

It should:

- authorize the request at the key/grant level
- construct proper execution context
- call the same service/repo paths used by the normal app where possible

## Audit and Attribution Design

## Existing audit reuse

The repo already has centralized audit patterns and `AuditContext` with `actorType: 'api_key'` support.

The design should extend this path by adding optional `apiKeyId` tracking rather than creating a fully separate audit system.

## Attribution rule

For MCP-originated actions:

- actor remains attributable to the human creator
- the active key id must also be recorded
- the request must be marked as machine-mediated

Recommended audit context fields:

- `actorId = creator user id`
- `actorType = 'api_key'`
- `apiKeyId = active key id`

## Audit event model

Add MCP-specific events into the existing audit vocabulary:

- `mcp.tool.invoked`
- `mcp.tool.succeeded`
- `mcp.tool.denied`
- `mcp.tool.failed`

Do not require a dedicated `mcp_audit_events` table for the first OSS release unless the current audit sink cannot hold the needed metadata.

## Performance and Abuse Controls

## `last_used_at`

Do not write on every request.

Use throttled updates, ideally at most once per hour per key.

## Search breadth

Broad search across many granted spaces is expensive.

Add:

- `MAX_SPACES_PER_SEARCH`, recommended default `20`

If the request omits `spaceId` and the key has more than the allowed number of readable spaces, fail the request or require narrowing.

## Response size

Large page bodies and search results must be truncated.

Initial safe defaults:

- max text content: 100 KB
- max list size: 50 items

Responses should clearly indicate truncation.

## Rate limiting

Use the repo's existing throttling infrastructure.

Initial concept:

- per IP limit
- per key limit
- stricter write limits than read limits

## Error Model

Use normalized MCP-safe errors:

- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

Resource enumeration rule:

- prefer `NOT_FOUND` when revealing resource existence would leak information

## Tool Design

## Initial OSS tool set

The first OSS launch should include:

- `get_current_user`
- `list_spaces`
- `get_space`
- `get_page`
- `list_pages`
- `list_child_pages`
- `search_pages`
- `get_comments`
- `create_page`
- `update_page`
- `create_comment`
- `update_comment` only if current comment rules map cleanly to delegated actor behavior

## Deferred tools

Defer initially:

- `create_space`
- `update_space`
- `duplicate_page`
- `move_page`
- `copy_page_to_space`
- `move_page_to_space`
- `search_attachments`
- `list_workspace_members`

Reasons:

- poor fit to per-space grant model
- exfiltration risk
- directory leakage risk
- cross-space integrity complexity

## Tool-specific design notes

### `get_current_user`

Return a principal view, not a user-session DTO.

Suggested fields:

- `type: 'api_key'`
- `apiKeyId`
- `apiKeyName`
- `workspaceId`
- `createdByUserId`
- `createdByDisplayName`

### `list_spaces`

- return only explicitly granted spaces still visible to the creator
- never derive from all workspace memberships automatically

### `get_space`

- require readable grant on that space

### `get_page`

- page must belong to a granted space
- creator must currently be able to view it
- page restriction logic must still run through existing domain code

### `list_pages`

- require `spaceId`
- filter results by visibility

### `list_child_pages`

- require visible parent page
- invisible parent should behave as not found

### `search_pages`

- restrict to granted spaces only
- no unauthorized snippets, counts, or hits
- broad search must obey `MAX_SPACES_PER_SEARCH`

### `create_page`

- require write grant on target space
- if parent provided, creator must be allowed to create under that parent

### `update_page`

- require write grant on page's space
- creator must currently be able to edit the page
- use optimistic concurrency for stale-write protection

### `get_comments`, `create_comment`, `update_comment`

- all comment operations remain subordinate to page visibility and current comment business rules
- if comment update semantics prove user-author-bound in a way that cannot safely support delegated editing, defer `update_comment`

## Resources and Prompts

These are useful but should remain lightweight in the first OSS delivery.

## Resources

Recommended initial resource form:

- `docmost://spaces/{spaceId}/pages/{pageId}`

Rules:

- same auth checks as tools
- no restricted content leakage

## Prompts

Prompts should be thin wrappers around tools/resources, not a second business-logic system.

Examples that are acceptable later:

- `summarize_space`
- `draft_design_page`

But prompts must not delay core transport/tool delivery.

## UI and Admin Requirements

OSS will need shared, non-EE client surfaces for:

- API key list
- create key flow
- one-time secret reveal
- revoke action
- per-space grant editor
- MCP endpoint display

The current EE-only client components can inform the design, but OSS-critical surfaces must move into shared client code.

## Security Requirements

These are mandatory for the first OSS release.

### API key lifecycle

- high-entropy generated secrets
- secret hashing with an explicitly chosen dependency/algorithm
- plaintext shown once only
- immediate revocation
- optional/default expiration support
- no full-key logging

### Authorization invariants

- default deny
- explicit per-space grants only
- creator is always the ceiling
- page restrictions always apply
- workspace binding enforced on every request

### Abuse controls

- per-key throttling
- per-IP throttling
- stricter write throttles
- truncation and pagination caps

## Implementation Strategy Summary

Recommended sequence:

1. extend OSS API key storage and management
2. add dedicated MCP auth guard/service
3. implement delegated authorization service
4. mount raw-compatible MCP transport at `/mcp`
5. ship read tools first
6. add mutation tools after conflict/audit tests pass
7. add OSS-safe UI surfaces

## Verification Requirements

Before launch, validate:

- valid/revoked/expired/malformed key behavior
- creator downgrade and removal behavior
- page restriction enforcement under MCP
- response truncation behavior
- rate limiting behavior
- protocol response shape compatibility
- audit attribution with `actorType: 'api_key'`

## Final Recommendation

The strongest OSS design is not a wholesale enterprise copy.

It is a thin integration layer that:

- extends the existing OSS `api_keys` foundation
- uses explicit per-space grants
- treats keys as delegated credentials
- mounts MCP at `/mcp` to match current bootstrap behavior
- relies on current page/space/comment services for real authorization decisions
- reuses the current audit and throttling infrastructure
- ships a narrow, high-confidence tool set first

That approach is the most secure and the best fit for Docmost's current architecture.
