// Normalizes OpenClaw's raw tool names into the same tool/action vocabulary
// used by AMP's Hermes plugin (AHP's policy.py), so a single AMP policy can
// govern both agent types identically instead of matching on each agent's
// own raw tool names.

const TOOL_MAP = {
  web_search: { tool: 'exec', action: 'web_search' },
  read:       { tool: 'read', action: 'read' },
  write:      { tool: 'write', action: 'write' },
  edit:       { tool: 'write', action: 'edit' },
  bash:       { tool: 'exec', action: 'exec' },
  shell:      { tool: 'exec', action: 'exec' },
};

/**
 * Returns { tool, action } for a raw OpenClaw tool name.
 * Unlike Hermes's normalizer (which returns null for anything outside its
 * known set), unmapped tools fall back to the raw name with action '*' —
 * so a not-yet-mapped OpenClaw tool still reaches AMP instead of being
 * silently dropped.
 */
export function normalizeTool(rawTool, params) {
  const mapped = TOOL_MAP[rawTool];
  if (mapped) return { tool: mapped.tool, action: mapped.action };
  return { tool: rawTool, action: params?.action || '*' };
}
