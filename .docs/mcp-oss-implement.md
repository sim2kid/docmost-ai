# OSS MCP Implementation Plan

This document translates the high-level design from `mcp-oss-design.md` into a concrete, step-by-step implementation roadmap.

## Implementation Strategy
The implementation follows a phased approach to minimize risk, ensuring that the authentication and authorization foundation is rock-solid before exposing any content-mutating tools.

---

## Phase 1: OSS API Key Foundation
**Goal**: Establish the ability to create, store, and validate API keys without relying on enterprise modules.

### 1.1 Database Schema
- Create `api_keys` table:
    - `id` (UUID, PK)
    - `public_id` (varchar, Unique, Indexed) - used for O(1) lookup.
    - `secret_hash` (varchar) - Argon2id/bcrypt hash of the secret.
    - `creator_id` (UUID, FK to users, ON DELETE CASCADE).
    - `status` (enum: active, revoked, expired).
    - `expires_at` (timestamp, nullable).
    - `last_used_at` (timestamp, nullable) - **Throttled Update Strategy**: Must not be written on every call. Implementation options:
        - **Threshold Check**: Read existing `last_used_at`; only write update if it is `null` or older than a configured threshold (e.g., 1 hour). Use a non-blocking fire-and-forget pattern or a deferred worker to avoid adding latency to the hot request path.
        - **Asynchronous Flush**: Buffer `last_used_at` events in-memory and flush them to the DB on a cron schedule (e.g., every 5-10 minutes) or via a background queue.

### 1.1.1 Attribution Schema Updates
- Existing content tables (`pages`, `comments`, etc.) currently track `createdByUserId` / `updatedByUserId`. To support actor attribution for AI actions, we need to track the API key.
- **Approach A (Column-based)**: Add nullable `created_by_api_key_id` / `updated_by_api_key_id` columns to relevant tables.
    - `pages`: add `updated_by_api_key_id`
    - `comments`: add `created_by_api_key_id`
- **Approach B (Audit-only)**: Skip table changes; rely solely on the `mcp_audit_events` table to link the action to the key.
- **Decision Required**: Pick one approach in Phase 1. Recommended: **Approach B** (audit-only) to avoid disruptive schema migrations on core tables in the OSS release.
- Ensure downstream consumers (e.g., the editor UI) can read attribution data to render `Creator Name (via AI)`.

### 1.2 `ApiKeyModule` Implementation
- **`ApiKeyRepo`**: CRUD operations for keys and grants.
- **`ApiKeyService`**: 
    - **Token Generation**: `dmk_<public_id>_<secret>_<checksum>`. Checksum is HMAC-SHA256 of public_id + secret using a system secret, calculated before hashing.
    - **Secret Storage**: Use `argon2id` for hashing. Plaintext secret shown only once at creation.
    - **Validation Flow**: Parse token $\rightarrow$ Verify checksum $\rightarrow$ Lookup by `public_id` $\rightarrow$ Verify hash $\rightarrow$ Check status/expiry $\rightarrow$ Return `McpPrincipal`.
    - **Grant Management**: Update grants with validation that the creator's current role $\ge$ requested scope.
- **API Endpoints**:
    - `POST /api/api-keys`: Returns full plaintext token once.
    - `GET /api/api-keys`: List metadata (no secrets).
    - `PATCH /api/api-keys/:id`: Update grants/metadata.
    - `DELETE /api/api-keys/:id`: Revoke key.

### 1.3 Auth Strategy Integration
- Implement `ApiKeyStrategy` (extending `PassportStrategy` or custom guard) to handle `X-API-Key` header.
- Remove the dynamic `require` of the enterprise API key service from `JwtStrategy` to decouple OSS auth from EE modules.
- Implement `McpAuthGuard` to protect `/api/mcp` routes and attach the `McpPrincipal` to the request.

---

## Phase 2: Effective Permission Engine
**Goal**: Implement the "Intersection" logic where API key grants are capped by the creator's current permissions.

### 2.1 `McpAuthorizationService`
- Implement `authorize(principal, toolName, params)`:
    - **Classification**: Map tool to `read` or `write`.
    - **Space Resolution**: Extract `spaceId` from params.
    - **Intersection Check**: `Effective = min(KeyGrant, CreatorCurrentRole, PageRestriction)`.
- Integrate with `SpaceMemberRepo` to resolve the creator's current highest role (direct or group).

### 2.2 Page-Level Restriction Integration
- Ensure all tool calls delegate to existing domain services (e.g., `PageService`) using the creator's user context to enforce page-level restrictions.
- Verify that the "creator impersonation" context is correctly passed to these services.

### 2.3 Creator Context Impersonation (`McpContextFactory`)
- NestJS domain services typically depend on a request-scoped `User` context. To avoid duplicating logic, the MCP layer will translate an `McpPrincipal` into a temporary, scoped `User` object representing the creator.
- Implement a **`McpContextFactory`** that produces a synthetic `RequestContext` (or `AuthUser`) wrapper.
- This factory must be used by all tool handlers to run domain logic as the creator, ensuring existing restriction checks run unmodified.
- **Safety**: The synthetic context must be clearly flagged as `actorType: 'api_key'` internally so audit logs and downstream services can distinguish human actions from machine actions.

### 2.4 Circular Dependency Mitigation
- `ApiKeyModule` will need to consult the `SpaceModule` (for membership lookups) and `UserModule` (for creator validation). The `McpModule` will depend on `ApiKeyModule`, `PageModule`, `SpaceModule`, and `CommentModule`.
- To prevent circular dependencies:
    - **`forwardRef`**: Use `forwardRef(() => ApiKeyModule)` in module imports where strictly necessary.
    - **Extract Permission Logic**: Abstract the "creator role vs space grant" intersection logic into a standalone `PermissionService` that has no dependencies on the MCP layer. Both `ApiKeyService` and `McpAuthorizationService` can depend on it.
    - **Interface Segregation**: `ApiKeyModule` should expose a minimal `McpPrincipal` interface, not a concrete class, so consumers don't need to import the full module type graph.


---

## Phase 3: MCP Transport & Core Module
**Goal**: Expose the MCP protocol over HTTP and register the tool registry.

### 3.1 `McpModule` Setup
- Implement the MCP HTTP endpoint (e.g., `/api/mcp`).
- Implement the MCP transport adapter (JSON-RPC / SSE).
- Create the `McpRegistry` to map tool names to handler functions.

### 3.2 Request Lifecycle
- Auth Guard -> `ApiKeyModule` -> `McpPrincipal` creation.
- Tool Request -> `McpRegistry` -> `McpAuthorizationService` -> Tool Handler.

### 3.3 Output Truncator (`McpResponseTruncator`)
- Tool handlers must not return raw, unbounded content to the MCP client.
- Implement a **`McpResponseTruncator`** utility that runs on every tool result before it is serialized to the protocol envelope.
- **Limits**: Default safe cap is **100KB** for text content and **50 results** for list responses (e.g., `search_pages`, `list_pages`).
- **Marker**: If a result is truncated, the truncator must append a standardized marker (e.g., `"... [Content truncated for length]"`) and a structured `truncated: true` flag in the response metadata so the AI client knows it has only a partial view.
- **Type-Specific Limits**: Truncation must respect content type (e.g., a 100KB string of markdown is different from a 100KB array of 50,000 small objects).

### 3.4 `McpAuditService` and Audit Logging
- Implement an **`McpAuditService`** that hooks into the tool lifecycle to log every invocation.
- **Events to Log**:
    - `mcp.tool.invoked` — `toolName`, `params` (sanitized of large content), `apiKeyId`, `creatorUserId`, `workspaceId`.
    - `mcp.tool.succeeded` — `toolName`, `targetResourceId` (e.g., `pageId`), `latencyMs`.
    - `mcp.tool.denied` — `toolName`, `reason` (`FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`), `apiKeyId`.
    - `mcp.tool.failed` — `toolName`, `errorCode`, `apiKeyId`.
- **Storage**: Write to the existing audit event pipeline or a dedicated `mcp_audit_events` table with proper indexing on `api_key_id` and `created_at`.
- **Redaction**: Ensure `params` and `content` payloads are redacted or size-capped to prevent log storage abuse.


---

## Phase 4: Tool Implementation (Read-Only)
**Goal**: Safely expose read-only content to AI agents.

### 4.1 Basic Read Tools
- `get_current_user`
- `get_space`
- `list_spaces`
- `get_page`
- `list_pages`
- `list_child_pages`

### 4.2 Search & Discovery Tools
- `search_pages` (with space filtering and result caps).
- `get_comments`
- `search_attachments` (with strict visibility checks).

---

## Phase 5: Tool Implementation (Write/Mutation)
**Goal**: Enable AI agents to contribute content under strict authorization.

### 5.1 Content Mutation Tools
- `create_page`
- `update_page`
- `create_comment`
- `update_comment`

### 5.2 Structural Tools (High Risk)
- `duplicate_page`
- `move_page`
- `copy_page_to_space`
- `move_page_to_space`

---

## Phase 6: Client UI & Admin Surfaces
**Goal**: Provide users with the tools to manage their AI integrations.

### 6.1 API Key Management UI
- Key creation modal (with one-time secret reveal).
- Space grant editor (with "Effective Access" warnings).
- Key list and revocation interface.

### 6.2 MCP Settings UI
- Endpoint URL display.
- Tool capability overview.

---

## Verification & QA Matrix
- [ ] **Auth**: Valid key works; revoked/expired/invalid keys fail.
- [ ] **Ceiling**: Key with `read_write` grant fails write if creator is `reader`.
- [ ] **Lifecycle**: Key fails immediately when creator is removed from space.
- [ ] **Restrictions**: Restricted pages are hidden from `get_page` and `search_pages`.
- [ ] **Leakage**: `list_spaces` only shows granted spaces.
- [ ] **Performance**: Search across 10+ spaces does not timeout or crash.
- [ ] **Attribution**: Page updates via MCP are tagged with `apiKeyId`.
- [ ] **Truncation**: 1MB page content returned via `get_page` is truncated to 100KB with a marker.
- [ ] **Throttling**: 100 rapid requests do not result in 100 `last_used_at` DB writes.
- [ ] **Audit**: Denied tool calls appear in `mcp_audit_events` with reason codes.

## In-Between Milestones (Testable Checkpoints)

To ensure the foundation is solid before building the UI or exposing tools, the implementation is gated by three verification checkpoints.

### Checkpoint 1: The Bearer Test (Post-Phase 1)
- **Test**: Create an API key directly via the `ApiKeyService` (or SQL), then send a `GET /api/mcp/health` request with the `X-API-Key` header.
- **What it Validates**:
    - Token generation and parsing.
    - Checksum logic (rejects malformed tokens without DB lookup).
    - `secret_hash` verification.
    - `ApiKeyStrategy` + `McpAuthGuard` integration.
- **Success Criteria**: `health` endpoint returns `200 OK`; revoked/expired/invalid keys return `401 Unauthorized`.

### Checkpoint 2: The Intersection Test (Post-Phase 2)
- **Test**: Write a unit test for `McpAuthorizationService` with a key having `read_write` grant for Space A, but the creator's current role in Space A is `reader`.
- **What it Validates**:
    - The "Permission Ceiling" logic.
    - Correct space membership resolution via `SpaceMemberRepo`.
    - Read vs Write classification logic.
- **Success Criteria**: The unit test confirms that an attempted `write` operation is denied even though the key is configured as `read_write`. No MCP transport or HTTP layer is required for this checkpoint.

### Checkpoint 3: The Discovery Test (Post-Phase 4)
- **Test**: Use the official `mcp-inspector` tool to connect to `/api/mcp` and call the `list_spaces` and `get_current_user` tools.
- **What it Validates**:
    - MCP transport layer (JSON-RPC / SSE) end-to-end.
    - `McpRegistry` correctly exposes tools.
    - Read-only authorization is enforced at the transport boundary.
    - `McpAuditService` records the invocations.
- **Success Criteria**: `mcp-inspector` successfully lists the granted spaces and returns a synthetic principal from `get_current_user`. Attempting an unauthorized read (e.g., a space not in the grants) is denied with a non-enumerating error.
