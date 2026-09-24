import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

/**
 * Validates a tool call's arguments against the target tool's own JSON
 * Schema, the way an MCP client would, before anything is forwarded. The
 * dialect follows the schema's `$schema` (2020-12, 2019-09, else draft-07,
 * which is what most MCP servers still emit). Unknown keywords are ignored
 * rather than rejected (`strict: false`), since a server's schema is not ours
 * to lint; formats are checked. Shared by the host (refuse before sending)
 * and the guest MCP host (refuse before calling the server).
 */
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: unknown) => unknown;
const options = { strict: false, allErrors: true, validateSchema: false, validateFormats: true } as const;
let draft7: Ajv | undefined, draft2019: Ajv2019 | undefined, draft2020: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

function engine(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const dialect = typeof schema.$schema === 'string' ? schema.$schema : '';
  if (dialect.includes('2020-12')) { if (!draft2020) { draft2020 = new Ajv2020(options); addFormats(draft2020); } return draft2020; }
  if (dialect.includes('2019-09')) { if (!draft2019) { draft2019 = new Ajv2019(options); addFormats(draft2019); } return draft2019; }
  if (!draft7) { draft7 = new Ajv(options); addFormats(draft7); }
  return draft7;
}

export type ArgumentCheck = { valid: true } | { valid: false; errors: string[] };

/** Check `args` against `schema`. A schema that cannot be compiled is reported as a failure, never as a pass. */
export function checkArguments(schema: unknown, args: unknown): ArgumentCheck {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { valid: false, errors: ['The target tool has no usable input schema.'] };
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    try {
      // `$id`s would collide across tools in one engine; the cache is by content instead.
      const { $id: _id, ...plain } = schema as Record<string, unknown>;
      validate = engine(plain).compile(plain);
    } catch (error) { return { valid: false, errors: [`The target tool's input schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`] }; }
    if (compiled.size > 512) compiled.clear();
    compiled.set(key, validate);
  }
  if (validate(args)) return { valid: true };
  const errors = (validate.errors ?? []).slice(0, 20).map(error => `${error.instancePath || '(arguments)'} ${error.message ?? 'is invalid'}${error.params && Object.keys(error.params).length ? ` ${JSON.stringify(error.params)}` : ''}`);
  return { valid: false, errors: errors.length ? errors : ['Arguments do not match the input schema.'] };
}
