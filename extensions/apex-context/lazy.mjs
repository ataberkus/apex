import {createCodemodeExtension, createToolSearchExtension} from '@earendil-works/pi-coding-agent';

export const LAZY_TOOL_NAMES = Object.freeze(['codemode', 'tool_search']);

/**
 * Register Pi's native discovery/orchestration tools, initially inactive.
 * The coordinator activates these names at session_start only with lazy enabled.
 * Rare tool definitions choose their own native codemode/deferred exposure.
 * Model access is disabled: scripts cannot issue classifier/model calls.
 * This does not register or connect MCP servers, or create external capabilities.
 */
export function registerLazyTools(pi) {
  createCodemodeExtension({models: false})(pi);
  createToolSearchExtension()(pi);
  return LAZY_TOOL_NAMES;
}
