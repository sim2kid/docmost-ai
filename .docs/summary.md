# Repository Summary: Docmost

Docmost is an open-source collaborative wiki and documentation software. It is designed to provide a centralized place for teams to create, share, and manage documentation with real-time collaboration.

## Architecture Overview
The repository is structured as a monorepo using `pnpm` workspaces and `nx`.

### Key Components
- **`apps/server`**: The backend server responsible for API logic, data management, and authentication.
- **`apps/client`**: The frontend application providing the user interface for documentation management and editing.
- **`packages/editor-ext`**: Extensions and utilities for the documentation editor.
- **`packages/ee`**: Enterprise Edition features and licensing.

## Core Features
- Real-time collaboration on pages.
- Integration of diagrams (Draw.io, Excalidraw, Mermaid).
- Organization via Spaces, Groups, and Permissions.
- Versioning via Page history and search capabilities.
- Support for multiple languages via Crowdin.
- Full-text search powered by Algolia.

## Licensing
- Core: AGPL 3.0.
- Enterprise: Proprietary license for specific directories (`apps/server/src/ee`, `apps/client/src/ee`, and `packages/ee`).
