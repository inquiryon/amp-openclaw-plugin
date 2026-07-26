#!/usr/bin/env bash
# Clear a stuck OpenClaw conversation session, plus the AOC plugin's AMP
# instance cache, in one step.
#
# Why this exists: `/new`/`/reset` are the normal way to start a fresh
# OpenClaw session, but in a workspace where another app (e.g. a separate
# Hermes bot) has already registered `/new` or `/reset` as a native Slack
# Slash Command, Slack routes those commands to that app's endpoint instead
# of ever delivering them to OpenClaw as a plain message — so they silently
# never reach OpenClaw at all. This script is a direct, Slack-independent
# way to get the same result.
#
# Usage:
#   ./scripts/clear-session.sh                    # clear the most recently
#                                                  # active channel session
#                                                  # for the "main" agent
#   ./scripts/clear-session.sh <agent>             # same, for another agent
#   ./scripts/clear-session.sh <agent> <session-key>  # clear one exact session
#   ./scripts/clear-session.sh --list [<agent>]    # list sessions to find a key
#
# By default (no session-key given), only the most recently active CHANNEL
# (group chat) session is cleared — direct-message sessions are left alone,
# so this can't accidentally wipe a real 1:1 conversation history.

set -euo pipefail

AMP_SESSION_FILE="/tmp/amp-session-state.json"  # matches plugin/index.js's SESSION_FILE

if [ "${1:-}" = "--list" ]; then
  openclaw sessions --agent "${2:-main}" --active 1440
  exit 0
fi

AGENT="${1:-main}"
KEY="${2:-}"
STORE="$HOME/.openclaw/agents/$AGENT/sessions/sessions.json"

if [ ! -f "$STORE" ]; then
  echo "No session store found at $STORE" >&2
  exit 1
fi

if [ -z "$KEY" ]; then
  KEY=$(jq -r '[to_entries[] | select(.value.chatType=="channel")] | sort_by(.value.updatedAt) | last | .key // empty' "$STORE")
  if [ -z "$KEY" ]; then
    echo "No active channel session found for agent \"$AGENT\" in $STORE" >&2
    echo "Run with --list to see what's there, or pass an explicit session key." >&2
    exit 1
  fi
fi

if [ "$(jq --arg k "$KEY" 'has($k)' "$STORE")" != "true" ]; then
  echo "Session key \"$KEY\" not found in $STORE" >&2
  echo "Run with --list to see current session keys." >&2
  exit 1
fi

TRANSCRIPT=$(jq -r --arg k "$KEY" '.[$k].sessionFile // empty' "$STORE")

jq --arg k "$KEY" 'del(.[$k])' "$STORE" > "$STORE.tmp" && mv "$STORE.tmp" "$STORE"
echo "Cleared session \"$KEY\" from $STORE"

if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  rm -f "$TRANSCRIPT"
  echo "Deleted transcript: $TRANSCRIPT"
fi

if [ -f "$AMP_SESSION_FILE" ]; then
  rm -f "$AMP_SESSION_FILE"
  echo "Cleared AMP instance cache: $AMP_SESSION_FILE"
else
  echo "No AMP instance cache to clear."
fi

echo ""
echo "Done. The next message will start a genuinely fresh session."
