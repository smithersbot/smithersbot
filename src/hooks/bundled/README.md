# Bundled Hooks

SmithersBot v0 does not ship any enabled bundled hooks by default.

Stage 2H removed the previous internal bundled hooks after confirming there were
no v0 importers in Telegram command handling, `/goal` execution, goal lessons,
or the supported hook loader surface. Keep hook infrastructure in place for
custom workspace and managed hooks.
