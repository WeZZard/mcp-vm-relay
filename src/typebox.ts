import { Type, type TUnsafe } from 'typebox';

export { Type };

/**
 * A string enum as a plain `enum` schema rather than anyOf/const, so every
 * provider adapter accepts it. Mirrors pi's own helper without importing pi:
 * the core stays usable from any agent runtime.
 */
export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: values as unknown as string[],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
