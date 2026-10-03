---
name: amp
description: "AMP Governance and HITL integration for Inquiryon"
metadata:
  openclaw:
    emoji: "🔗"
#   events: ["message", "task:start", "tool:*", "task:end"]
    events: ["message", "message:sent"]
    requires:
      bins: ["node"]
---

# AMP Hook

This hook integrates OpenClaw with the **Inquiryon AMP (Agent Management Platform)** to provide governance, activity logging, and lifecycle management.

## Integration Lifecycle
1. **Init**: on the first inbound `message:received` for a conversation (a new AMP instance via `/api/agent/init`).
2. **Log**: each inbound prompt is logged to AMP as `User prompt: ...`. `message:sent` (agent replies) is not logged as a prompt.
3. **Tools**: `tool:*` / `task:*` events are not delivered by OpenClaw (>= 2026.7) — tool logging and governance live in the plugin (`index.js`).
4. **SetState**: on restart, an orphaned hook-owned instance is finalized from `$OPENCLAW_STATE_DIR/hooks/amp/hook-session.json` (default `~/.openclaw/...`). The plugin keeps its own `plugin-session.json`; neither side touches the other's instance.

Config is read from `$OPENCLAW_STATE_DIR/hooks/amp/amp_config.json` (default `~/.openclaw/hooks/amp/amp_config.json`). If it is missing or invalid the hook does nothing and retries on the next event.
