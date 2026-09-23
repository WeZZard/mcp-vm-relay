import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { selectedEnvironment } from './environment.js';

/** Injectable process context; resolving configuration never creates files. */
export interface ConfigOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function nonblank(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) throw new TypeError(`${label} must be nonblank text without NUL characters`);
  return value;
}

export function absolute(value: string, label: string): string {
  nonblank(value, label);
  if (!isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return normalize(value);
}

/** MCP_VM_RELAY_STATE_DIR > XDG_STATE_HOME/mcp-vm-relay > ~/.local/state/mcp-vm-relay. */
export function relayStateRoot(options: ConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return selected.profile.relayStateDir;
  if (env.MCP_VM_RELAY_STATE_DIR !== undefined) return absolute(env.MCP_VM_RELAY_STATE_DIR, "MCP_VM_RELAY_STATE_DIR");
  if (env.XDG_STATE_HOME !== undefined) return join(absolute(env.XDG_STATE_HOME, "XDG_STATE_HOME"), "mcp-vm-relay");
  return join(absolute(options.home ?? env.HOME ?? homedir(), "home"), ".local", "state", "mcp-vm-relay");
}

/** Resolve a Python executable name through PATH unless explicitly overridden. */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return nonblank(env.MCP_VM_RELAY_PYTHON ?? "python3", "MCP_VM_RELAY_PYTHON");
}

/** Environment-only diagnostic candidate, not legacy AGENTS.md autodetection. */
export function registryDiagnosticsPath(options: ConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const selected = selectedEnvironment(env, options.home);
  if (selected) return join(selected.profile.relayStateDir, 'registry.md');
  if (env.MCP_VM_RELAY_REGISTRY !== undefined) {
    return absolute(env.MCP_VM_RELAY_REGISTRY, "MCP_VM_RELAY_REGISTRY");
  }
  return join(relayStateRoot(options), "registry.md");
}
