# Architecture

StructBoard combines a Vue 3 interface, a Tauri desktop shell, a Python local backend and Mol* structure rendering.

- `frontend/components`, `frontend/application`, `frontend/domain`: interface components, workspace commands and domain rules.
- `frontend/runtime`, `frontend/canvas`, `frontend/views`: structure operations, the route map and rendering adapters.
- `desktop`: native windows, file dialogs and desktop lifecycle.
- `desktop_backend.py`, `pipeline_api.py`: local structure access and pipeline storage.
- `harness_broker.py`, `mcp_server.py`, `client_setup.py`: scoped AI connections and client configuration.
- `demo_data.py`: deterministic artificial structures, sequences, scores and demo pipeline definitions.
- `resource_contract.py`, `public-source.json`: explicit build inputs and public source inventory.

Large structure buffers and Mol* viewer objects stay outside the Vue reactive state. Overview cards are virtualized and covers are generated on demand. User files and persisted workspaces are runtime data; they do not belong in the source tree.

Use `tools/migration_workspace.py preview` for an isolated local preview. Its disposable data stays below `_migration/`. Do not copy production profiles into the development tree.
