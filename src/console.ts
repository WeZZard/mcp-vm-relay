// Only allowlisted non-secret observations cross the backend boundary.
export interface ConsoleAttemptStatus {
  attempt_id?: string; status: string; reason: string | null;
  transport_connected: boolean | 'unknown'; viewer_cleanup: string;
  authentication: string; viewer_connected: string; human_confirmation: string;
}
export interface ConsoleStatus {
  schemaVersion: 1; vm?: string; lease_id?: string; console_id?: string;
  environment_fingerprint?: string | null;
  status: string; reason: string | null; backend?: string; viewer_location: string;
  authentication: string; authentication_mechanism: string; viewer_connected: string; human_confirmation: string; pixels: string;
  server_enforced_view_only: boolean | 'unknown';
  session_binding: string; readiness_scope: string;
  observed_at?: number; source?: string; access_expires_at?: number;
  attempt?: ConsoleAttemptStatus;
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const token = (v: unknown): string | undefined => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(v) ? v : undefined;
export function consoleStatus(value: unknown): ConsoleStatus {
  const v = object(value);
  if (v.schemaVersion !== 1) throw new Error('Unsupported or malformed console report schema');
  const result: ConsoleStatus = {
    schemaVersion: 1, status: token(v.status) ?? 'unknown', reason: token(v.reason) ?? null,
    viewer_location: token(v.viewer_location) ?? 'unknown', authentication: token(v.authentication) ?? 'unknown',
    viewer_connected: token(v.viewer_connected) ?? 'unknown', human_confirmation: token(v.human_confirmation) ?? 'unknown',
    authentication_mechanism: token(v.authentication_mechanism) ?? 'unknown', pixels: token(v.pixels) ?? 'unknown',
    server_enforced_view_only: typeof v.server_enforced_view_only === 'boolean' ? v.server_enforced_view_only : 'unknown',
    session_binding: token(v.session_binding) ?? 'unknown', readiness_scope: token(v.readiness_scope) ?? 'unknown',
  };
  for (const key of ['vm', 'lease_id', 'console_id', 'backend', 'source'] as const) { const s = token(v[key]); if (s) result[key] = s; }
  if (v.environment_fingerprint === null) result.environment_fingerprint = null;
  else if (token(v.environment_fingerprint)) result.environment_fingerprint = token(v.environment_fingerprint);
  for (const key of ['observed_at', 'access_expires_at'] as const) if (typeof v[key] === 'number' && Number.isFinite(v[key])) result[key] = v[key];
  if (v.attempt !== undefined) {
    const a = object(v.attempt);
    result.attempt = {
      attempt_id: token(a.attempt_id), status: token(a.status) ?? 'unknown', reason: token(a.reason) ?? null,
      transport_connected: typeof a.transport_connected === 'boolean' ? a.transport_connected : 'unknown',
      viewer_cleanup: token(a.viewer_cleanup) ?? 'unknown', authentication: token(a.authentication) ?? 'unknown',
      viewer_connected: token(a.viewer_connected) ?? 'unknown', human_confirmation: token(a.human_confirmation) ?? 'unknown',
    };
  }
  return result;
}
export function acquisitionCapabilities(value: unknown) {
  const v = object(value), option = object(object(v.options).vnc), backends = object(option.backends);
  if (v.schemaVersion !== 1 || option.default !== false || !['linux', 'macos'].every(k => typeof object(backends[k]).available === 'boolean')) throw new Error('Unsupported or malformed acquisition-capabilities schema');
  const backend = (v: unknown) => { const b = object(v); return { available: b.available as boolean, status: token(b.status) ?? 'unknown', backend: token(b.backend) ?? 'unknown', viewer_location: token(b.viewer_location) ?? 'unknown', authentication: token(b.authentication) ?? 'unknown', guest_readiness: token(b.guest_readiness) ?? 'unknown', session_binding: token(b.session_binding) ?? 'unknown', server_enforced_view_only: typeof b.server_enforced_view_only === 'boolean' ? b.server_enforced_view_only : 'unknown', pixels: token(b.pixels) ?? 'unknown', human_confirmation: token(b.human_confirmation) ?? 'unknown' }; };
  return { schemaVersion: 1, options: { vnc: { default: false, backends: { linux: backend(backends.linux), macos: backend(backends.macos) } } } };
}
