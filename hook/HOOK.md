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
1. **Init**: Triggered on `task:start`.
2. **Log**: Triggered on `tool:end` for agentic actions.
3. **SetState**: Triggered on `task:end` to finalize the instance.
