# OSS MCP Implementation Plan

This document translates `mcp-oss-design.md` into a repository-fit implementation plan for Docmost OSS. It is written to be directly actionable inside the current monorepo structure.

## Repo-Fit Corrections Applied

Before implementation begins, the following repository realities must shape the work:

- The server is NestJS/Fastify under `apps/server/src`.
- `main.ts` excludes `mcp` from the global `/api` prefix, so the MCP transport should mount at `/mcp`, not `/api/mcp`, unless `main.ts` is intentionally changed.
- An OSS `api_keys` table already exists via `apps/server/src/database/migrations/20250912T101500-api-keys.ts`; Phase 1 must extend that table rather than create a brand-new one from scratch.
- Generated Kysely types already include `ApiKeys` in `apps/server/src/database/types/db.d.ts`.
- `JwtStrategy` currently hard-depends on an EE API key validation path and must be decoupled for OSS.
- `AuditContext` already supports `actorType: 'api_key'`, so the audit integration work should extend existing plumbing instead of inventing a parallel audit model.
- No verified `argon2` or `bcrypt` dependency is currently present in the repo. The implementation must either add one explicitly or use an existing approved crypto path after verification. This must not be left implicit.
- Many existing controllers and decorators assume `request.raw.workspace`, `request.raw.workspaceId`, or `@AuthWorkspace()` are already available via `DomainMiddleware`; MCP must preserve that workspace context shape.
- The repo already supports raw-response bypass via `@SkipTransform()`, which should be used for MCP protocol handlers.
- `CommentService.update(...)` currently allows only the original comment creator to edit a comment, making `update_comment` unsafe for guaranteed initial scope.
- OSS `search_pages` should target the current Postgres-backed `SearchService` path and must not depend on EE Typesense modules.

## Delivery Principle

Deliver this in narrow, testable slices. Do not expose mutation tools until the OSS API-key model, delegated authorization ceiling, and request attribution are working end to end.

## Recommended Initial Scope

Ship first:

- OSS API key management
- Space-grant model with default deny
- MCP HTTP transport at `/mcp`
- Read tools:
  - `get_current_user`
  - `list_spaces`
  - `get_space`
  - `get_page`
  - `list_pages`
  - `list_child_pages`
  - `search_pages`
  - `get_comments`
- Then mutation tools:
  - `create_page`
  - `update_page`
  - `create_comment`

Defer from initial OSS launch:

- `create_space`
- `update_space`
- `duplicate_page`
- `move_page`
- `copy_page_to_space`
- `move_page_to_space`
- `search_attachments`
- `list_workspace_members`
- `update_comment`
- prompt/resource subscription complexity beyond basic resources/prompts

These deferred items are either high-risk for exfiltration/integrity or do not map cleanly to the current per-space grant model.

---

## Phase 0: Pre-Implementation Alignment

**Goal**: remove ambiguity before code changes.

### 0.1 Confirm dependency choices

- Decide secret hashing package explicitly.
- If `argon2` is added, update workspace package manifests and deployment docs accordingly.
- If `bcrypt` is preferred, document performance and native-build implications.
- If neither is acceptable, define an approved existing crypto utility path before implementation.

### 0.2 Confirm route contract

- Use `/mcp` as the transport endpoint to match `apps/server/src/main.ts`.
- Keep REST-style API key management endpoints under `/api/...`.
- Ensure `/mcp` requests still resolve workspace identity through the same self-host/cloud domain model used elsewhere in the app.

### 0.3 Confirm OSS feature behavior

- Remove or relax current EE-only gating for `mcpEnabled` in `WorkspaceService` where required for OSS launch.
- Ensure API key management is not gated behind `Feature.API_KEYS` in an EE-only path.
- Decide whether OSS will expose workspace-level toggle UI for MCP immediately or infer enablement from API key/module availability.
- Defer `update_comment` by default unless product explicitly approves a change to current comment ownership/edit semantics.

### 0.4 Confirm schema migration strategy

Because `api_keys` already exists, implementation must add follow-up migrations instead of replacing the existing table. The plan should assume additive migrations only.

---

## Phase 1: OSS API Key Foundation

**Goal**: create a first-class OSS API key domain that supports delegated MCP authentication without EE dependencies.

## 1.1 Server module placement

Add a new domain module under:

- `apps/server/src/core/api-key/`

Suggested file layout:

- `api-key.module.ts`
- `api-key.controller.ts`
- `api-key.service.ts`
- `api-key.types.ts`
- `dto/create-api-key.dto.ts`
- `dto/update-api-key.dto.ts`
- `dto/revoke-api-key.dto.ts` if needed
- `dto/api-key-id.dto.ts`

Add database repo(s) under the existing repo structure, not ad hoc inside the module:

- `apps/server/src/database/repos/api-key/api-key.repo.ts`
- `apps/server/src/database/repos/api-key/api-key-grant.repo.ts` if separated

## 1.2 Database changes

### 1.2.1 Extend existing `api_keys` table

Current existing columns:

- `id`
- `name`
- `creator_id`
- `workspace_id`
- `expires_at`
- `last_used_at`
- `created_at`
- `updated_at`
- `deleted_at`

Add a follow-up migration to support actual credential validation and lifecycle:

- `public_id` `text not null unique`
- `secret_hash` `text not null`
- `description` `text null`
- `status` `text not null default 'active'`
- `revoked_at` `timestamptz null`
- `revoked_by_user_id` `uuid null references users.id on delete set null`

Add indexes:

- unique `public_id`
- `(workspace_id, status)`
- `(creator_id, status)`

Do not remove `deleted_at`; align with existing soft-delete conventions where useful.

### 1.2.2 Create `api_key_space_grants`

Add a new table for explicit grants:

- `id` uuid pk default `gen_uuid_v7()`
- `api_key_id` uuid not null references `api_keys.id` on delete cascade
- `space_id` uuid not null references `spaces.id` on delete cascade
- `scope` text not null
- `created_at` timestamptz not null default `now()`
- `updated_at` timestamptz not null default `now()`

Constraints:

- unique `(api_key_id, space_id)`
- `scope` constrained to `read_only` or `read_write`

Indexes:

- `(api_key_id)`
- `(space_id)`

### 1.2.3 Kysely type regeneration

After migrations:

- regenerate `apps/server/src/database/types/db.d.ts`
- verify `entity.types.ts` exports remain aligned

This step must be explicit in the implementation checklist.

## 1.3 API key token shape

Use opaque bearer tokens:

- `dmk_<publicId>_<secret>_<checksum>`

Validation flow:

1. Read `Authorization: Bearer <token>`.
2. Parse into `publicId`, `secret`, `checksum`.
3. Verify checksum before DB lookup.
4. Load key by `publicId`.
5. Verify `secret` against `secret_hash`.
6. Fail closed if revoked, deleted, expired, or workspace mismatch.
7. Load grants.
8. Construct `McpPrincipal`.

### Checksum detail

- Use HMAC-SHA256 over `<publicId>:<secret>` with an app secret-derived server key.
- Truncate to a short stable prefix such as 8 hex chars.
- This is for early malformed-token rejection only, not the primary security boundary.

### Secret hashing detail

- Store only `secret_hash`.
- Plaintext secret is returned exactly once on create.
- Never log or emit the full token after creation.

## 1.4 `ApiKeyService`

Core responsibilities:

- create key
- hash secret
- build token string
- list keys without secrets
- revoke key
- update metadata
- replace or update per-space grants atomically
- validate bearer token into principal
- throttle `last_used_at` writes

Recommended methods:

- `createKey(user, workspaceId, dto)`
- `listKeys(user, workspaceId)`
- `updateKey(user, workspaceId, keyId, dto)`
- `revokeKey(user, workspaceId, keyId)`
- `validateBearerToken(token)`
- `touchLastUsedAt(keyId)`
- `getPrincipalForKey(apiKey)`

### Grant update rule

When creating/updating grants, validate each requested space grant against the creator's current effective role in that space. The server must reject grants that exceed what the creator can currently do.

### `last_used_at` write strategy

Do not update on every request. Match existing throttled-activity patterns:

- preferred: update only if older than 1 hour
- implementation can be async fire-and-forget or queued
- failed touch updates must not fail the MCP request

## 1.5 REST management endpoints

Create authenticated OSS endpoints under `/api/api-keys` using existing Nest controller patterns.

Endpoints:

- `POST /api/api-keys`
- `GET /api/api-keys`
- `PATCH /api/api-keys/:id`
- `DELETE /api/api-keys/:id`

Controller conventions to match repo:

- protect with `@UseGuards(JwtAuthGuard)`
- use `@AuthUser()` and `@AuthWorkspace()`
- validate DTOs via existing global validation pipe
- return standard wrapped responses via the existing response interceptor

Response rules:

- `POST` returns the one-time plaintext token plus metadata
- `GET`/`PATCH` never return the secret or full token

### Workspace binding requirement

These endpoints should continue using the normal `/api` request path with `DomainMiddleware` and `@AuthWorkspace()`.

All API-key CRUD operations must enforce:

- key workspace equals authenticated workspace
- creator user belongs to authenticated workspace
- cross-workspace access fails closed

## 1.6 Auth integration cleanup

### Option A: preferred for MCP

Implement a dedicated MCP auth path instead of trying to force opaque keys into `JwtStrategy`:

- `apps/server/src/integrations/mcp/auth/mcp-auth.guard.ts`
- `apps/server/src/integrations/mcp/auth/mcp-auth.service.ts`
- `apps/server/src/integrations/mcp/auth/mcp-principal.ts`

This guard should:

- extract bearer token
- call `ApiKeyService.validateBearerToken`
- attach `{ principal, user, workspace }`-style request context for MCP handlers
- populate `request.raw.workspaceId` and `request.raw.workspace` when needed so downstream workspace-dependent code remains compatible

### Option B: cleanup legacy JWT API-key support

If `JwtType.API_KEY` is kept for compatibility, remove the EE-only dynamic require from:

- `apps/server/src/core/auth/strategies/jwt.strategy.ts`

But this should be treated as a separate compatibility concern, not a blocker for MCP if dedicated guard-based auth is cleaner.

**Recommendation**: use dedicated MCP auth for opaque tokens now, then optionally revisit JWT API-key compatibility later.

---

## Phase 2: Delegated Authorization Engine

**Goal**: implement the key-grant ∩ creator-live-access model without duplicating Docmost permission logic.

## 2.1 New authorization service

Add under:

- `apps/server/src/integrations/mcp/services/mcp-authorization.service.ts`

Responsibilities:

- classify tool as read vs write
- resolve target space from tool params or loaded target resource
- load the key's explicit grant for that space
- resolve creator's current effective space capability
- reject operations that exceed either bound
- require downstream page/comment services to still enforce page-level restrictions

## 2.2 Capability model

Use a very small internal capability enum:

- `none`
- `read`
- `write`

Mapping:

- key `read_only` -> `read`
- key `read_write` -> `write`
- space role `reader` -> `read`
- space role `writer` -> `write`
- space role `admin` -> `write` for MCP purposes unless a specific tool explicitly requires admin semantics

Then compute:

- `effectiveCapability = min(keyCapability, creatorCapability)`

Do not invent a broader admin-like MCP capability for the initial launch.

## 2.3 Space resolution rules

Each tool handler must provide enough information for authorization to resolve target space deterministically.

Examples:

- `get_space`, `list_pages`, `search_pages(spaceId)` -> direct `spaceId`
- `get_page`, `update_page`, `get_comments` -> load page first, derive `spaceId`
- `create_comment` -> load page first, derive `spaceId`

For tools without clean space scoping, defer them rather than weakening authorization.

## 2.4 Page restriction enforcement

Do not reproduce page restriction logic in MCP.

Instead:

- use existing `PageAccessService`
- route reads/mutations through existing domain services/repo flows already used by controllers
- run those calls with a creator-backed user context so the same restrictions apply

### Search implementation constraint

Initial MCP `search_pages` must use the OSS `SearchService` behavior as the baseline.

Rules:

- do not depend on EE Typesense modules
- preserve existing permission filtering behavior
- layer any extra MCP response shaping on top of already-filtered OSS results

## 2.5 Creator context factory

Add:

- `apps/server/src/integrations/mcp/services/mcp-context.factory.ts`

Responsibilities:

- convert `McpPrincipal` into the user/workspace context expected by existing services
- annotate request/audit context with `actorType: 'api_key'`
- preserve the human creator identity while carrying `apiKeyId` in metadata

Compatibility requirements:

- set the request user/workspace shape expected by decorators and interceptors when handlers reuse existing conventions
- preserve `request.raw.workspace` and `request.raw.workspaceId`
- avoid fabricating unrelated browser-session fields

This factory should be the only supported bridge from MCP transport to domain services.

## 2.6 Disabled/deleted creator behavior

Fail closed when:

- creator is disabled
- creator is deleted
- creator workspace mismatch exists
- creator no longer belongs to workspace

The key remains stored but becomes unusable.

---

## Phase 3: MCP Transport Module

**Goal**: expose a stable MCP endpoint that is thin, auditable, and aligned with existing server structure.

## 3.1 Module placement

Add under:

- `apps/server/src/integrations/mcp/`

Suggested layout:

- `mcp.module.ts`
- `mcp.controller.ts`
- `mcp.registry.ts`
- `dto/` if transport DTOs are needed
- `auth/`
- `services/`
- `tools/`
- `resources/`
- `prompts/`
- `utils/mcp-response-truncator.ts`

Import this module from a repo-appropriate parent module, likely `AppModule` or an integrations aggregator if one exists for similar features.

## 3.2 Transport endpoint

Mount at:

- `/mcp`

Reasons:

- matches `main.ts` exclusion list
- avoids accidental `/api` workspace middleware assumptions for protocol traffic
- aligns with current routing reality

If MCP requires health/introspection helpers, prefer:

- `GET /mcp/health`
- protocol handler under `/mcp`

## 3.3 Response format behavior

Because the app uses a global `TransformHttpResponseInterceptor`, the MCP transport must verify whether MCP responses need raw protocol envelopes instead of wrapped `{ data, success, status }` output.

Implementation requirement:

- explicitly bypass or disable the standard response wrapper for MCP protocol routes if the MCP client expects raw JSON-RPC/SSE payloads

Repository-fit detail:

- use `@SkipTransform()` on MCP protocol handlers

This is a critical slot-in detail and must be validated early.

## 3.4 Tool registry

`McpRegistry` should:

- register tool descriptors
- map tool names to handlers
- expose schemas and metadata
- centralize classification metadata (`read` vs `write`)

Do not scatter tool metadata across controllers and handlers.

## 3.5 Response truncation

Implement `McpResponseTruncator` and run it on every large content/list response.

Initial limits:

- max text payload: 100 KB
- max list items: 50

Return metadata such as:

- `truncated: true`
- `truncationReason: 'content_limit' | 'item_limit'`

This should be transport-safe and deterministic.

## 3.6 Rate limiting

Leverage the existing throttling infrastructure in:

- `apps/server/src/integrations/throttle/throttle.module.ts`

Add MCP-specific throttler names and guard logic rather than inventing a parallel mechanism.

Recommended first-pass limits:

- per IP read: 100/min
- per API key read: 60/min
- per workspace read: 500/min
- per API key write: 10/min

Implementation detail:

- build tracker keys using API key id when authenticated, else IP fallback
- log denials as MCP audit events

---

## Phase 4: Audit and Attribution

**Goal**: make MCP activity attributable without depending on undocumented EE-only surfaces.

## 4.1 Reuse existing audit pipeline

The repo already has:

- `AuditContext` in `common/middlewares/audit-context.middleware.ts`
- `AuditActorInterceptor` in `common/interceptors/audit-actor.interceptor.ts`
- existing `auditService.log(...)` usage throughout core modules

Implementation should extend this path, not create a completely separate audit framework.

## 4.2 Audit context extension

Extend `AuditContext` with:

- `apiKeyId?: string | null`

Update `AuditActorInterceptor` and/or MCP auth/context setup so MCP requests record:

- `actorId = creator user id`
- `actorType = 'api_key'`
- `apiKeyId = active key id`

This preserves the existing audit actor model while distinguishing machine-mediated actions.

## 4.3 MCP-specific audit events

Prefer adding MCP events to the existing event vocabulary instead of creating a separate OSS-only table first.

Recommended events:

- `mcp.tool.invoked`
- `mcp.tool.succeeded`
- `mcp.tool.denied`
- `mcp.tool.failed`

Metadata:

- `toolName`
- `apiKeyId`
- `workspaceId`
- `creatorUserId`
- `resourceId` where known
- sanitized params summary
- latency where relevant

### Important constraint

Do not make the initial OSS delivery depend on a custom `mcp_audit_events` table unless the existing audit sink proves insufficient. Existing audit plumbing is the lower-risk slot-in path.

## 4.4 UI attribution surface

Do not block the MCP backend launch on a broad "AI-generated" UI redesign.

Instead, define a minimal attribution follow-up:

- surface API-key-origin metadata in responses where already natural
- add targeted UI labeling later if/when OSS pages/comments expose machine attribution in their DTOs

This keeps Phase 1-5 feasible and avoids invasive core-table attribution changes in the first OSS release.

## 4.5 Audit metadata limits

MCP audit payloads must be bounded.

Rules:

- never log full page or comment bodies by default
- truncate serialized params summaries aggressively
- prefer ids, tool names, and reason codes over payload duplication

---

## Phase 5: Read Tool Delivery

**Goal**: release safe, highly useful read tools first.

## 5.1 Handler structure

Suggested pattern per tool:

- schema/descriptor in registry
- handler in `integrations/mcp/tools/<tool>.tool.ts`
- handler calls authorization service
- handler uses context factory
- handler delegates to existing service/repo path

## 5.2 Initial read tools and mapping

### `get_current_user`

Return principal-style metadata, not a fake browser session.

Fields:

- `type: 'api_key'`
- `apiKeyId`
- `apiKeyName`
- `workspaceId`
- `createdByUserId`
- `createdByDisplayName`

### `list_spaces`

- Only list spaces explicitly granted and still accessible to creator.
- Never enumerate ungranted spaces.

### `get_space`

- Require readable grant for the space.
- Return only fields already safe in existing space APIs.

### `get_page`

- Reuse existing page fetch path where possible.
- Must pass through `PageAccessService`-equivalent checks.
- Support format options only if they map cleanly to existing `PageController` behavior.

### `list_pages`

- Require `spaceId`.
- Filter results through existing visibility rules.

### `list_child_pages`

- Load parent page first.
- Treat invisible parent as `NOT_FOUND`.

### `search_pages`

- Restrict search to granted spaces only.
- If no `spaceId`, enforce `MAX_SPACES_PER_SEARCH`.
- Do not leak snippets/counts from unauthorized pages.

### `get_comments`

- Require readable access to the parent page.
- Reuse existing comment visibility rules.

## 5.3 Resources and prompts

Keep this minimal in the first implementation.

Resources:

- page resource URIs like `docmost://spaces/{spaceId}/pages/{pageId}`

Prompts:

- only lightweight prompts that compose existing tools

Do not let resources/prompts delay the core tool delivery.

## 5.4 Search result parity

The current OSS search path returns filtered page search results with highlight/rank-oriented fields.

MCP `search_pages` should either:

- adapt that current result set directly, or
- transform it into an MCP-friendly shape without expanding visibility or depending on unimplemented metadata

Do not promise search capabilities beyond what the current OSS search path can actually support unless they are separately implemented.

---

## Phase 6: Mutation Tool Delivery

**Goal**: add content-creation/editing only after read/auth/audit paths are stable.

## 6.1 Initial mutation tools

- `create_page`
- `update_page`
- `create_comment`

Defer by default:

- `update_comment`

## 6.2 Mutation safety rules

### `create_page`

- require target space `write`
- if `parentPageId` exists, validate creator can edit/create beneath that parent

### `update_page`

- require page-space `write`
- add optimistic concurrency input:
  - `expectedUpdatedAt` or
  - `version` if a native version field exists in the real page model

Repository-fit rule:

- choose the field that best matches the existing page persistence model after inspecting the real update path; do not promise both unless both are implemented.

### `create_comment`

- require parent page readable + writable/commentable under existing rules

### `update_comment`

- current repo behavior only allows the original comment creator to edit the comment
- because MCP actions execute through delegated API-key context, this creates an ownership mismatch for comments authored previously by the human user or another automation run
- therefore `update_comment` should be deferred from the first implementation unless authorship/edit rules are intentionally redesigned

## 6.3 Explicitly deferred structural tools

Keep these out of the first execution slice:

- `duplicate_page`
- `move_page`
- `copy_page_to_space`
- `move_page_to_space`

Reason:

- cross-tree and cross-space integrity risk
- exfiltration risk
- higher need for source + destination authorization proofs

---

## Phase 7: Client OSS Surfaces

**Goal**: expose minimal OSS UI for key management and MCP connection details using existing client conventions.

## 7.1 Client placement

Move/adapt EE-only patterns into shared client locations such as:

- `apps/client/src/features/api-key/...`
- `apps/client/src/features/mcp/...`
- `apps/client/src/pages/settings/...` or the repo’s actual settings route structure

Do not keep OSS-critical UI under `src/ee/...`.

## 7.2 Minimal UI deliverables

- API key list
- create key modal/flow
- one-time secret reveal screen
- revoke action
- per-space grant editor
- MCP endpoint display (`/mcp` based URL)

## 7.3 Workspace toggle behavior

Because `workspace.service.ts` currently license-gates `mcpEnabled`, implementation must choose one of:

- remove OSS gating and keep the toggle, or
- remove the toggle from initial OSS UI and treat MCP as enabled when module/config is available

Recommended path:

- keep backend support for `settings.ai.mcp`
- remove EE gating for OSS
- expose a simple toggle only if it has real enforcement value

---

## Verification Plan

## Checkpoint 1: Bearer Authentication

Verify:

- valid opaque key authenticates to `/mcp/health`
- malformed checksum fails
- bad secret fails
- revoked key fails
- expired key fails

## Checkpoint 2: Delegated Authorization Ceiling

Unit-test `McpAuthorizationService` with table-driven cases:

- key `read_write` + creator `reader` => write denied
- key `read_only` + creator `writer` => write denied
- key valid + creator removed from space => denied
- key valid + page restricted => treated as hidden/denied

## Checkpoint 3: Protocol Response Shape

Using an MCP client/inspector, verify:

- `/mcp` returns raw protocol-compatible payloads
- global HTTP response wrapping does not corrupt MCP responses
- workspace resolution still works on `/mcp` in self-hosted and cloud hostname modes

## Checkpoint 4: Read Tools

Verify:

- `list_spaces` only returns granted spaces
- `get_page` respects page restrictions
- `search_pages` does not leak unauthorized snippets/counts
- truncation metadata is present on oversized responses
- `search_pages` works through the OSS Postgres-backed search path without Typesense

## Checkpoint 5: Mutation Safety

Verify:

- stale `update_page` request fails with conflict-style error
- mutations are audited with `actorType: 'api_key'`
- `last_used_at` updates are throttled and do not write on every request

## Test inventory to add

Server unit tests:

- `api-key.service.spec.ts`
- `mcp-authorization.service.spec.ts`
- registry/tool handler specs where logic is non-trivial

Server integration/e2e tests:

- authenticated MCP health/handshake path
- read tool happy path
- read tool denied path
- mutation conflict path

Client tests, only where UI is moved into OSS shared code:

- create/reveal key flow
- grant editor validation

---

## Concrete File Targets

Expected backend files to add or change:

- `apps/server/src/core/api-key/api-key.module.ts`
- `apps/server/src/core/api-key/api-key.controller.ts`
- `apps/server/src/core/api-key/api-key.service.ts`
- `apps/server/src/core/api-key/dto/*`
- `apps/server/src/database/repos/api-key/api-key.repo.ts`
- `apps/server/src/database/repos/api-key/api-key-grant.repo.ts`
- `apps/server/src/integrations/mcp/mcp.module.ts`
- `apps/server/src/integrations/mcp/mcp.controller.ts`
- `apps/server/src/integrations/mcp/mcp.registry.ts`
- `apps/server/src/integrations/mcp/auth/*`
- `apps/server/src/integrations/mcp/services/mcp-authorization.service.ts`
- `apps/server/src/integrations/mcp/services/mcp-context.factory.ts`
- `apps/server/src/integrations/mcp/tools/*`
- `apps/server/src/integrations/mcp/utils/mcp-response-truncator.ts`
- `apps/server/src/common/middlewares/domain.middleware.ts` only if MCP workspace compatibility requires a targeted update
- `apps/server/src/common/middlewares/audit-context.middleware.ts`
- `apps/server/src/common/interceptors/audit-actor.interceptor.ts`
- `apps/server/src/common/decorators/skip-transform.decorator.ts` reused for MCP handlers
- `apps/server/src/core/auth/strategies/jwt.strategy.ts` if legacy API-key cleanup is included
- `apps/server/src/integrations/throttle/throttler-names.ts`
- `apps/server/src/integrations/throttle/*` as needed for MCP throttling
- `apps/server/src/database/migrations/<timestamp>-api-key-oss-fields.ts`
- `apps/server/src/database/migrations/<timestamp>-api-key-space-grants.ts`
- `apps/server/src/database/types/db.d.ts`

Expected client files to add or change:

- shared OSS-safe API key feature files under `apps/client/src/features/...`
- shared OSS-safe MCP settings files under `apps/client/src/features/...` or `pages/...`
- `apps/client/src/App.tsx` route wiring
- workspace types if needed for MCP settings exposure

---

## Final Implementation Guidance

The implementation should optimize for repository fit, not theoretical completeness.

That means:

- extend the existing `api_keys` table instead of replacing it
- mount MCP at `/mcp` to match current bootstrap behavior
- use dedicated opaque-token MCP auth rather than forcing everything through JWT
- reuse existing page/comment/space permission services wherever possible
- reuse the existing audit pipeline with minimal extensions
- preserve workspace-resolution assumptions already used throughout the app
- use `@SkipTransform()` for protocol handlers
- ship a narrow, high-confidence tool set first
- defer structurally risky tools and `update_comment` until the delegated authorization model is proven in OSS

If executed in this order, the result should slot into Docmost cleanly without depending on EE-only modules or introducing a parallel authorization model.
