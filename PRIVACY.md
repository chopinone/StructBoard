# Data separation

The public repository contains application source, tests, build configuration, brand assets and a programmatic synthetic demo. It contains no user pipeline definitions or research structure datasets.

The desktop app stores workspaces and imported pipeline definitions in the current user's application data directory. The original structure files remain at locations selected by that user. Client grants, discovery files, AI settings, backups and browser storage are runtime data and must not be committed.

Structure rendering and file reading run locally. When a user explicitly connects an AI provider or MCP client, the information sent depends on that client's request and the permissions granted. Do not treat enabling an external AI provider as an offline operation.

`public-source.json` is the publication allowlist. `.gitignore` provides an additional convenience layer; it does not remove previously committed content. `tools/check_public_source.py` checks tracked files, common credential forms, personal paths and reviewed image hashes. Use `--all-files` on a clean delivery directory to check its entire inventory.

Automated scans cannot identify every possible confidential phrase. Review new descriptions, examples, model names, test values, images and release notes before publication. Keep any private project-specific search terms outside the public repository.
