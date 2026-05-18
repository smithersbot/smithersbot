# Bundled Hooks

SmithersBot v0 does not ship any enabled bundled hooks by default.

The previous internal hooks were quarantined under `src/hooks/_deferred/` during
Stage 2G because current evidence showed no v0 importers in Telegram command
handling, `/goal` execution, goal lessons, or the supported hook loader surface.
Keep hook infrastructure in place for custom workspace and managed hooks.
