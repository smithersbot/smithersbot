# Bundled Hooks

This directory contains hooks that ship with SmithersBot. These hooks are discovered automatically and can be enabled or disabled through the CLI or configuration.

## Available Hooks

### session-memory

Automatically saves session context to memory when you issue `/new`.

**Events**: `command:new`  
**What it does**: Creates a dated memory file with an LLM-generated slug based on conversation content.  
**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md`

**Enable**:

```bash
smithersbot hooks enable session-memory
```

See `src/hooks/bundled/session-memory/HOOK.md`.

### command-logger

Logs command events to a centralized audit file.

**Events**: `command`  
**What it does**: Appends JSONL entries to the command log file.

**Enable**:

```bash
smithersbot hooks enable command-logger
```

See `src/hooks/bundled/command-logger/HOOK.md`.

### soul-evil

Swaps injected `SOUL.md` content with `SOUL_EVIL.md` during a purge window or by random chance.

**Events**: `agent:bootstrap`  
**What it does**: Overrides the injected SOUL content before the system prompt is built.  
**Output**: No files written; swaps happen in memory only.

**Enable**:

```bash
smithersbot hooks enable soul-evil
```

See `src/hooks/bundled/soul-evil/HOOK.md`.

### boot-md

Runs `BOOT.md` whenever the gateway starts after channels start.

**Events**: `gateway:startup`  
**What it does**: Executes `BOOT.md` instructions through the agent runner.  
**Output**: Whatever the instructions request, such as outbound messages.

**Enable**:

```bash
smithersbot hooks enable boot-md
```

See `src/hooks/bundled/boot-md/HOOK.md`.

## Hook Structure

Each hook is a directory containing:

- `HOOK.md`: metadata and documentation in YAML frontmatter plus Markdown
- `handler.ts`: the hook handler function

Example structure:

```text
session-memory/
├── HOOK.md
└── handler.ts
```

## HOOK.md Format

```yaml
---
name: my-hook
description: "Short description"
metadata:
  { "smithersbot": { "emoji": "link", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---
# Hook Title

Documentation goes here.
```

### Metadata Fields

- `emoji`: display marker for CLI output
- `events`: events to listen for, such as `["command:new", "session:start"]`
- `requires`: optional requirements
- `install`: installation methods for bundled hooks

Requirements can include:

- `bins`: required binaries on PATH
- `anyBins`: at least one binary from the list must be present
- `env`: required environment variables
- `config`: required config paths, such as `["workspace.dir"]`
- `os`: required platforms, such as `["darwin", "linux"]`

## Creating Custom Hooks

To create your own hooks, place them in:

- Workspace hooks: `<workspace>/hooks/`
- Managed hooks: `~/.smithersbot/hooks/`

Custom hooks follow the same structure as bundled hooks.

## Managing Hooks

List all hooks:

```bash
smithersbot hooks list
```

Show hook details:

```bash
smithersbot hooks info session-memory
```

Check hook status:

```bash
smithersbot hooks check
```

Enable or disable hooks:

```bash
smithersbot hooks enable session-memory
smithersbot hooks disable command-logger
```

## Configuration

Hooks can be configured in `~/.smithersbot/smithersbot.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": {
          "enabled": true
        },
        "command-logger": {
          "enabled": false
        }
      }
    }
  }
}
```

## Event Types

Currently supported events:

- `command`: all command events
- `command:new`: `/new` command specifically
- `command:reset`: `/reset` command
- `command:stop`: `/stop` command
- `agent:bootstrap`: before workspace bootstrap files are injected
- `gateway:startup`: gateway startup after channels start

## Handler API

Hook handlers receive an `InternalHookEvent` object:

```typescript
interface InternalHookEvent {
  type: "command" | "session" | "agent" | "gateway";
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
}
```

Example handler:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  event.messages.push("Hook executed.");
};

export default myHandler;
```

## Testing

Test your hooks by:

1. Place the hook in the workspace hooks directory.
2. Restart the gateway using the normal local development command for this repository.
3. Enable the hook: `smithersbot hooks enable my-hook`.
4. Trigger the event, such as sending `/new`.
5. Check gateway logs for hook execution.
