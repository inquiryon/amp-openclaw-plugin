# OpenClaw AMP Integration

This repository contains the **AMP Governance Plugin** for [OpenClaw](https://openclaw.ai) — an integration that brings Inquiryon's **Agent Management Platform (AMP)** governance capabilities to OpenClaw agents operating over WhatsApp and other messaging channels.

## What It Does

When an OpenClaw agent attempts to call a tool (e.g. web search, file read/write, shell commands), the plugin intercepts the call and checks it against a governance policy defined in AMP. Depending on the policy:

- **Allowed** — the tool runs immediately, and the action is logged in AMP.
- **HITL required** — the agent pauses, the user receives a WhatsApp notification, and a human reviewer approves, modifies, or rejects the action in AMP before the agent proceeds.
- **Blocked** — the action is rejected outright (no active policy, or policy explicitly blocks it).

This gives organizations transparency, accountability, and human oversight over their AI agents — the three pillars of AMP's governance model.

## Repository Structure

```
openclaw/
├── plugin/               # AMP Governance Plugin (published to npm)
│   ├── index.js          # Plugin entry point — governance logic
│   ├── openclaw.plugin.json
│   ├── package.json
│   └── hook/             # Hook files bundled with the plugin (auto-deployed on install)
│       ├── handler.ts    # AMP Hook — conversation lifecycle & activity logging
│       ├── HOOK.md       # Hook manifest
│       └── amp_config.json  # Config template (credentials go here)
│
├── hook/                 # Source copy of the hook files (for reference/development)
│   ├── handler.ts
│   ├── HOOK.md
│   └── amp_config.json
│
└── docs/                 # Documentation
    ├── AMP-GOVERNANCE-SETUP.md   # End-user setup guide
    └── assets/
        └── AMP-OpenClaw-WhatsApp.png
```

## Two Components

### 1. AMP Hook (`hook/handler.ts`)
An OpenClaw hook that runs inside the gateway process. It handles the per-conversation lifecycle:
- Creates an AMP agent instance when a new conversation starts
- Logs every inbound message and tool call to AMP
- Closes the instance when the conversation ends

### 2. AMP Governance Plugin (`plugin/index.js`)
An OpenClaw plugin published to npm as `@inquiryon/amp-governance`. It intercepts every tool call before execution and enforces the AMP governance policy:
- Calls `/api/hitl/request` on the AMP backend
- If HITL is required: sends an immediate WhatsApp notification and polls for a human decision
- Returns `{ block: true, blockReason }` to block the tool, or `{}` to allow it
- On decision (approve/reject/timeout): sends a follow-up WhatsApp notification

## Quick Start

See the full setup guide: [docs/AMP-GOVERNANCE-SETUP.md](docs/AMP-GOVERNANCE-SETUP.md)

**Short version:**

```bash
# 1. Install the plugin (also auto-deploys the hook files)
openclaw plugins install @inquiryon/amp-governance

# 2. Fill in your AMP credentials
nano ~/.openclaw/hooks/amp/amp_config.json

# 3. Restart OpenClaw
openclaw restart
```

Then create a governance policy for your agent in AMP and you're live.

## Governance Policy

Policies are defined in AMP and stored as `policy.json` under the agent's directory. The eval policy supports three evaluator types:

| Type | Description |
|---|---|
| `compute` | Fast Python-style formula (e.g. keyword matching, numeric thresholds) |
| `llm` | LLM semantic reasoning — assesses intent, not just keywords |
| `hybrid` | Combines both: `compute_then_llm`, `llm_then_compute`, `either`, or `both` |

HITL routing is configured via `hitl_spec` in the policy:

```json
{
  "hitl_spec": {
    "when": "eval_policy",
    "who":  "reviewer@example.com",
    "what": "approval",
    "where": "amp"
  }
}
```

A sample policy template covering web search, file access, bash, payments, stock trading, and email is available in the [AMP policy library](https://amp.inquiryon.com).

## Published Package

The plugin is published to npm:

```
@inquiryon/amp-governance
```

Latest version and changelog: [npmjs.com/package/@inquiryon/amp-governance](https://www.npmjs.com/package/@inquiryon/amp-governance)
