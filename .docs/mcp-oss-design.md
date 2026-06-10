# OSS MCP Design For Docmost

## Purpose

This document defines the proposed design for bringing Docmost MCP support into the open-source version of the repository.

The immediate goal is to support AI integrations through an MCP server authenticated by API key, with access limited explicitly by space.

This document is intended to be the working implementation spec for the first iteration.

## Background

The repository already contains evidence of enterprise-only MCP support and API key authentication paths:

- Client enterprise MCP settings UI exists in `apps/client/src/ee/ai/components/mcp-settings.tsx`
- The `mcp` feature flag already exists in `apps/server/src/common/features.ts`
- API key JWT payload support already exists in `apps/server/src/core/auth/dto/jwt-payload.ts`
- `TokenService` can already generate API-key JWTs in `apps/server/src/core/auth/services/token.service.ts`
- OSS currently cannot validate API keys because `JwtStrategy` dynamically loads the API key service from `ee` and throws if the enterprise module is missing

This means the repo already has some of the plumbing, but the OSS version does not yet have a first-class API key implementation or an MCP server implementation available without enterprise code.

## Product Goals

We want an MCP server that allows AI assistants and tools to interact with Docmost content safely.

The design must satisfy these requirements:

- Authentication is done with API keys
- API keys are denied access to all spaces by default
- API keys must be granted access to each space explicitly
- Each granted space must be either `read_only` or `read_write`
- The API key must never have more access than the user who created it
- If the creating user loses access or is downgraded, the API key must lose that access immediately
- Space access must not bypass page-level restrictions
- The free version should copy or adapt the existing enterprise MCP capability where possible rather than inventing a parallel product

## Domain Model

The design depends on the existing Docmost content structure:

- A workspace contains spaces
- A space contains pages
- A page may have a parent page or `null` parent if it is at the root of the space
- Spaces already have role-based access via `admin`, `writer`, and `reader`
- Page-level restrictions can further narrow what a user can see or edit inside a space

This is important because MCP authorization must layer on top of the current Docmost permission model rather than replacing it.

## Core Design Principle

API keys must be treated as delegated credentials, not independent service accounts.

The API key does not define authority by itself. It only narrows the authority of the user who created it.

For any MCP request, effective permission must be the intersection of:

- the API key being valid and active
- the API key having an explicit grant for the target space
- the requested action fitting within the grant scope
- the creating user still having the corresponding space access right now
- the creating user still passing page-level restrictions right now

In short: API key permission is always capped by current user permission.

## Effective Permission Rules

For each space grant, the key can be configured as one of:

- `read_only`
- `read_write`

Docmost space roles already imply these capabilities:

- `reader` -> read only
- `writer` -> read and write page/comment content
- `admin` -> read and write, plus space administration abilities in the normal app

The final MCP permission for a tool call is the minimum of:

- the key's configured grant for the space
- the creator's current effective space role
- any page-level restriction for the target page or its ancestors

Examples:

- If a key has `read_write` for a space, but the creator is currently only a `reader`, the key becomes effectively read only
- If a key has `read_only` for a space and the creator is a `writer`, the key still remains read only
- If the creator loses access to the space entirely, the key becomes unusable for that space
- If a page is restricted and the creator cannot read it, the key cannot read it either even if the key has a space grant

## Proposed Server Architecture

The MCP implementation should be introduced in OSS as a first-class module and should remain thin.

It should not reimplement page, space, comment, or membership rules.

### New OSS Modules

Recommended server areas:

- `apps/server/src/core/api-key`
- `apps/server/src/integrations/mcp`

### `ApiKeyModule`

Suggested responsibilities:

- create API keys
- revoke API keys
- rotate API keys later if needed
- store hashed key secrets
- resolve a presented bearer token to an API key record
- load per-space grants for the key
- compute effective access based on current creator permissions
- expose a machine principal for MCP requests

Suggested files:

- `api-key.module.ts`
- `api-key.service.ts`
- `api-key.repo.ts`
- `dto/*`
- `types/*`

### `McpModule`

Suggested responsibilities:

- serve the MCP endpoint
- register MCP tools and their schemas
- authenticate requests using API keys
- build a request-scoped MCP execution context
- route tool calls into existing domain services
- map internal exceptions into MCP-safe errors

Suggested files:

- `mcp.module.ts`
- `mcp.controller.ts` or transport-specific entrypoint
- `mcp.service.ts`
- `mcp.registry.ts`
- `tools/*`
- `auth/*`

### `McpAuthorizationService`

This should be a dedicated service rather than scattered checks in every tool handler.

Responsibilities:

- classify tool calls as read or write
- resolve the relevant space for the request
- verify explicit API key grant
- determine the creator's current effective access in that space
- ensure the action does not exceed the effective capability
- ensure page-level restrictions are still enforced by the downstream service path

## Authentication Design

### Current Repository State

Today, `JwtStrategy` supports `JwtType.API_KEY`, but validation only works if the enterprise API key service can be dynamically required. In OSS this fails.

That enterprise-only dependency should be removed from the critical authentication path for the free version.

### Recommended Authentication Model

Use opaque API keys as bearer credentials.

Recommended token shape:

- `dmk_<public_id>_<secret>_<checksum>`
+
+Where:
+
+- `<public_id>` is a non-secret identifier used for lookup
+- `<secret>` is a high-entropy random secret shown only once at creation time
+- `<checksum>` is a small CRC or checksum of the secret to allow the server to reject malformed keys before database lookup


### Storage Requirements

Store:

- API key id
- workspace id
- creator user id
- name
- optional description
- token public identifier or prefix
- hashed secret
- status
- expiration timestamp
- last-used timestamp
- created and updated timestamps

Do not store the plaintext secret.

The secret should be hashed using a password-grade algorithm such as Argon2id or bcrypt, depending on what best fits the existing stack.

### Validation Flow

For each MCP request:

1. Read bearer token from `Authorization` header
2. Parse token into public identifier and secret
3. Look up the API key by public identifier
4. Verify secret hash
5. Reject if revoked, expired, or otherwise inactive
6. Resolve creator user and workspace
7. Resolve the key's configured space grants
8. Build an MCP principal containing the key id, workspace id, creator user id, and grant information

### JWT Compatibility

The repository already supports API-key JWT payloads, but for OSS MCP the safest initial design is to validate the raw opaque API key on each request.

If the implementation later needs a derived short-lived JWT for internal guard reuse, that JWT must still remain tied to current key state and revocation status.

## Authorization Model

### Default Deny

API keys have zero space access unless a grant is explicitly configured.

No access should be inherited automatically from:

- workspace membership
- creator ownership
- creator's general list of spaces
- historical permissions at the time the key was created

### Per-Space Grants

Each key can have a set of space grants:

- one grant record per space
- scope is either `read_only` or `read_write`

### Creator Permission Ceiling

The creating user's live access is authoritative.

If the creator is removed from a space, the key loses access to that space.

If the creator is downgraded from `writer` to `reader`, the key immediately loses write access even if the configured grant is still `read_write`.

If the creator is disabled or removed from the workspace entirely, the key should fail closed for all operations.

### Group Membership

Because Docmost already derives space access through direct membership or groups, the effective key permission must use the creator's current highest role via the existing space membership logic.

This means group membership changes must affect key behavior immediately or as close to immediately as existing permission caching allows.

### Page Restrictions

Space grants are necessary but not sufficient.

Page restrictions must still be enforced for:

- `get_page`
- `search_pages`
- `list_pages`
- `list_child_pages`
- page updates
- comment operations
- attachment search and retrieval
- page moves, copies, and duplication

The MCP layer must not become a bypass around existing page restriction logic.

## Proposed Data Model

### `api_keys`

Suggested fields:

- `id`
- `workspace_id`
- `created_by_user_id`
- `name`
- `description` nullable
- `token_prefix` or public identifier
- `secret_hash`
- `status` such as `active` or `revoked`
- `expires_at` nullable
- `last_used_at` nullable
- `created_at`
- `updated_at`
- `revoked_at` nullable
- `revoked_by_user_id` nullable

Suggested constraints:
- `created_by_user_id` should have `ON DELETE CASCADE` or a corresponding hook in `ApiKeyModule` to ensure all keys are revoked if the creator account is deleted.

Suggested indexes:


- unique index on public identifier
- index on `(workspace_id, status)`
- index on `created_by_user_id`

### `api_key_space_grants`

Suggested fields:

- `id`
- `api_key_id`
- `space_id`
- `scope` with values `read_only` or `read_write`
- `created_at`
- `updated_at`

Suggested constraints and indexes:

- unique `(api_key_id, space_id)`
- foreign key to `api_keys`
- foreign key to `spaces`
- index on `space_id`

### Why Separate Grant Records

This keeps the permission model explicit and easy to audit.

It also makes it straightforward to show configured access in the UI and compare it to currently effective access.

## MCP Transport

The repository should expose MCP over HTTP at a stable endpoint, likely `/mcp` or `/api/mcp` depending on current routing conventions.

The transport layer should stay replaceable. The implementation should not entangle business rules with a specific MCP SDK.

At a high level:

1. Client connects to MCP endpoint
2. Client authenticates with API key
3. MCP server resolves the execution context
4. Tool handler validates input
5. Authorization service checks access
6. Existing domain service executes the operation
7. Result is returned in MCP-compliant format

## Tool Design

The current UI already lists the intended tool set:

- `search_pages`
- `get_page`
- `create_page`
- `update_page`
- `list_pages`
- `list_child_pages`
- `duplicate_page`
- `copy_page_to_space`
- `move_page`
- `move_page_to_space`
- `get_space`
- `list_spaces`
- `create_space`
- `update_space`
- `get_comments`
- `create_comment`
- `update_comment`
- `search_attachments`
- `list_workspace_members`
- `get_current_user`

The sections below define intended behavior, minimum input expectations, and authorization rules.

### Actor Attribution and Audit
+
+When an action is performed via an API key, the system must track both the human creator and the specific key used.
+
+- **Attribution**: Actions (e.g., creating a comment, updating a page) should be tagged with the `apiKeyId` in the database/audit logs.
+- **UI Transparency**: In the user interface, actions performed via MCP should be visually distinguished (e.g., `Creator Name (via AI)`) to ensure transparency.
+- **Tool Usage Logging**: Every successful and failed tool call must be logged, including `toolName`, `targetResourceId` (e.g., `pageId`), and `apiKeyId`.
+
### Authorization Latency & Caching
+
+Because effective access must be lost "immediately" upon creator downgrade:
+
+- The `McpAuthorizationService` must ensure it does not rely on stale permission caches for high-security write operations.
+- If standard permission caching is used, the implementation must ensure that membership/role changes trigger immediate cache invalidation for associated API keys.
+
### Search Scope & Performance
+
+To prevent resource exhaustion when searching across many granted spaces:
+
+- Introduce a "max spaces" limit for a single search request.
+- Enforce strict timeouts at the transport layer for search operations.
+
## Common Tool Rules


### Read vs Write Classification

Read tools:

- `search_pages`
- `get_page`
- `list_pages`
- `list_child_pages`
- `get_space`
- `list_spaces`
- `get_comments`
- `search_attachments`
- `list_workspace_members`
- `get_current_user`

Write tools:

- `create_page`
- `update_page`
- `duplicate_page`
- `copy_page_to_space`
- `move_page`
- `move_page_to_space`
- `create_space`
- `update_space`
- `create_comment`
- `update_comment`

### Error Model

Recommended normalized errors:

- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `INTERNAL_ERROR`

To avoid unauthorized resource enumeration, prefer `NOT_FOUND` when revealing the existence of an object would leak information.

## Page Tools

### `search_pages`

Purpose:

- search pages by keyword within authorized spaces

Minimum inputs:

- `query`
- optional `spaceId`
- optional pagination

Authorization:

- if `spaceId` is supplied, the key must have readable access to that space
- if `spaceId` is omitted, search must be restricted to the set of granted readable spaces only
- page-level restrictions still apply to every result

Constraints:

- no results from ungranted spaces
- no snippets from unauthorized pages
- no unauthorized hit counts

### `get_page`

Purpose:

- return page content and metadata for a specific page

Minimum inputs:

- `pageId`

Authorization:

- page's space must be granted for read
- creator must currently be able to read the page
- page restriction logic must still be applied

### `create_page`

Purpose:

- create a page in a space

Minimum inputs:

- `spaceId`
- `title`
- optional `content`
- optional `parentPageId`

Authorization:

- key must have `read_write` grant for the target space
- creator must currently have write capability in that space
- if a parent page is provided, creator must be able to create under that page

### `update_page`

Purpose:

- update an existing page's title or content

Minimum inputs:

- `pageId`
- at least one field to update

Authorization:

- key must have `read_write` grant for the page's space
- creator must currently be able to edit the page

### `list_pages`

Purpose:

- list pages in a space

Minimum inputs:

- `spaceId`
- optional pagination

Authorization:

- readable grant on the target space
- results filtered through page visibility rules

### `list_child_pages`

Purpose:

- list child pages of a specific page

Minimum inputs:

- `parentPageId`

Authorization:

- parent page must be visible
- returned children must also be visible under page restriction rules

### `duplicate_page`

Purpose:

- duplicate a page within its space

Minimum inputs:

- `pageId`
- optional destination parent if supported by current page service

Authorization:

- read access to the source page
- write access to the destination location

Security note:

- this tool becomes much riskier if it duplicates descendants with mixed page-level visibility

### `copy_page_to_space`

Purpose:

- copy a page to a different space

Minimum inputs:

- `pageId`
- `targetSpaceId`
- optional `targetParentPageId`

Authorization:

- readable access to the source page and source space
- writable access to the target space and target parent if provided

Security note:

- this is a major exfiltration vector and should be treated as a high-risk tool

### `move_page`

Purpose:

- move a page within a space or within an allowed page tree context

Minimum inputs:

- `pageId`
- destination parent or position info

Authorization:

- write access to the page
- write access to the destination location

### `move_page_to_space`

Purpose:

- move a page to a different space

Minimum inputs:

- `pageId`
- `targetSpaceId`
- optional destination parent

Authorization:

- write access to the source page
- write access to the target space

Security note:

- this is also high-risk because it combines integrity changes with possible cross-space data movement

## Space Tools

### `get_space`

Purpose:

- return details of a specific space

Minimum inputs:

- `spaceId`

Authorization:

- readable grant on the target space

### `list_spaces`

Purpose:

- list spaces the API key can currently access

Minimum inputs:

- none

Authorization:

- authenticated API key

Constraints:

- only spaces explicitly granted to the key and still accessible to the creator should be returned

### `create_space`

Purpose:

- create a new space

Problem:

- this does not map cleanly onto a per-space grant model because the target space does not exist yet

Recommendation:

- do not include `create_space` in the initial OSS launch unless a separate workspace-level permission model is intentionally added

### `update_space`

Purpose:

- update a space's name or description

Minimum inputs:

- `spaceId`
- fields to update

Authorization:

- `read_write` grant on the space is not enough by itself
- creator should also currently be a space `admin` if the existing domain rules require admin-level space management

## Comment Tools

### `get_comments`

Purpose:

- return comments for a page

Minimum inputs:

- `pageId`

Authorization:

- readable access to the page

### `create_comment`

Purpose:

- add a comment to a page

Minimum inputs:

- `pageId`
- `content`

Authorization:

- `read_write` grant for the page's space
- creator must currently be allowed to comment on that page
- any viewer-comment or page-level comment setting must still apply

### `update_comment`

Purpose:

- update an existing comment

Minimum inputs:

- `commentId`
- updated content

Authorization:

- `read_write` grant for the related space
- comment edit rules already used by the main app must still apply

## Other Tools

### `search_attachments`

Purpose:

- search attachments across accessible content

Minimum inputs:

- `query`
- optional `spaceId`

Authorization:

- readable space access
- attachment access must remain tied to page visibility or equivalent attachment-level authorization

Security note:

- attachment metadata can itself be sensitive and this tool should be treated carefully

### `list_workspace_members`

Purpose:

- return workspace members the caller is allowed to view

Security note:

- this is not naturally space-scoped and can expose directory information such as names and emails

Recommendation:

- defer this tool from the initial OSS launch unless the product explicitly wants machine access to workspace directory data and the permission model is tightened for it

### `get_current_user`

Purpose:

- return the authenticated identity context for the API key

Recommendation:

- return an API-key principal view rather than pretending this is a browser user session

Suggested fields:

- `type: "api_key"`
- `apiKeyId`
- `apiKeyName`
- `workspaceId`
- `createdByUserId`
- `createdByDisplayName`

## Recommended Initial OSS Tool Set

Based on the architecture and security review, the first OSS launch should be narrower than the full enterprise list.

Recommended initial tools:

- `get_current_user`
- `get_space`
- `list_spaces`
- `get_page`
- `search_pages`
- `list_pages`
- `list_child_pages`
- `get_comments`
- `create_page`
- `update_page`
- `create_comment`
- `update_comment`

Recommended to defer until the permission model is proven in OSS:

- `duplicate_page`
- `copy_page_to_space`
- `move_page`
- `move_page_to_space`
- `create_space`
- `update_space`
- `search_attachments`
- `list_workspace_members`

This does not mean those tools are impossible. It means they are higher risk and should follow after the base auth model is validated.

## UI and Admin Requirements

The OSS client will need API key management and MCP settings moved out of enterprise-only paths or reimplemented in shared OSS-safe locations.

### Minimum UI Requirements

- MCP settings page showing endpoint URL
- API key list page
- create API key flow
- one-time key reveal screen
- revoke key action
- per-space grant editor
- visible grant scope selector with `Read Only` and `Read and Write`
- warnings when configured access exceeds currently effective access due to creator downgrade

### Validation Requirements

During key creation or update:

- the server must reject any requested grant the creator cannot currently hold
- the UI should also prevent obvious invalid combinations for usability, but server-side validation remains authoritative

## Security Requirements

The security review produced the following non-negotiable requirements for launch.

### API Key Lifecycle

- high-entropy generated secrets
- hashed secret storage
- plaintext shown once only
- immediate revocation
- optional or default expiration support
- no logging of full key values
- audit logging for create, revoke, grant changes, and sensitive MCP actions

### Authorization Invariants

- explicit per-space default deny
- no workspace-wide implied access
- creator permission is always the upper bound
- page restrictions always override space grants
- cross-space operations require authorization on both source and destination
- workspace binding must be enforced for every request

### Safe Error Behavior

- invalid, revoked, and expired keys should fail with generic authentication errors
- unauthorized objects should usually return `NOT_FOUND` rather than revealing they exist
- search and list operations must not leak unauthorized counts or snippets

### Abuse Controls

- per-key rate limiting
- per-IP rate limiting
- stricter limits for write tools than read tools
- size and pagination caps for search and list operations
- operational protections around expensive tree operations when they are introduced

## Implementation Approach

The best path is incremental rather than trying to port the entire enterprise MCP feature set in one pass.

### Phase 1: OSS API Key Foundation

- create OSS `ApiKeyModule`
- add database tables for API keys and per-space grants
- implement create, list, revoke, and update endpoints
- replace enterprise-only API key validation path in auth with an OSS-native implementation

### Phase 2: Effective Permission Engine

- implement `McpAuthorizationService`
- integrate creator role resolution using current membership logic
- add tests for downgrade, removal, group membership changes, and page restrictions

### Phase 3: MCP Transport

- implement `McpModule`
- add endpoint and tool registration
- wire request auth and error mapping

### Phase 4: Read-Focused MCP Launch

- ship lower-risk tools first
- verify logs, audit events, and rate limits

### Phase 5: Write Tools

- add page and comment mutation tools
- validate write authorization thoroughly

### Phase 6: Higher-Risk Tools

- revisit cross-space copy/move, space management, attachments, and workspace member tools only after the base system is stable

## Testing Requirements

The following cases should be covered before launch.

### Authentication Tests

- valid key works
- invalid key fails
- revoked key fails immediately
- expired key fails immediately

### Authorization Tests

- no grant means no access
- `read_only` key cannot perform writes
- `read_write` key can perform writes only when creator can too
- creator downgrade immediately reduces access
- creator removal immediately removes access
- group membership changes affect key access correctly

### Data Leakage Tests

- unauthorized spaces do not appear in `list_spaces`
- unauthorized pages do not leak through `get_page`
- restricted pages do not leak through `search_pages`
- restricted child pages do not leak through `list_child_pages`
- attachments do not leak metadata without authorization

### Write Integrity Tests

- page updates respect page-level restrictions
- comment updates respect current edit rules
- future move/copy tools enforce both source and destination permissions

## Final Recommendations

The recommended plan is:

- implement API keys in OSS as a first-class capability
- model per-space grants explicitly with default deny
- treat API keys as delegated credentials whose effective power is always capped by the creator's current access
- reuse existing Docmost service logic for page, space, and comment behavior instead of copying business rules into MCP handlers
- ship a smaller initial MCP tool set focused on core read and basic write operations
- defer cross-space and directory-style tools until the auth model is fully tested in OSS

This gives Docmost a practical MCP foundation for AI usage without creating a security bypass around the repository's existing permission system.
