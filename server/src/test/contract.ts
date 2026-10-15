import { z } from 'zod';
import { envelope } from '../contract/common';

/**
 * Parse `value` with a contract schema and return the parsed data. On failure
 * throw one error listing every issue as `<path>: <message>` (`<root>` for the
 * top level), so a strict schema names the leaked or missing key (zod's
 * `unrecognized_keys` message already quotes the key names).
 *
 * Route tests pass the serialised body (`res.body`, through `envelope(...)`),
 * never a controller's in-memory value — a `Date` only becomes an ISO string
 * inside `res.json`.
 */
export function expectContract<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `  ${path}: ${issue.message}`;
  });
  throw new Error(`value does not match the contract:\n${lines.join('\n')}`);
}

/**
 * Check a serialised route body is the `{ data, meta }` envelope and return its
 * `data`, for the caller to parse with the payload's own schema:
 * `expectContract(PostDTOSchema, envelopeData(res.body))`.
 */
export function envelopeData(body: unknown): unknown {
  const { data } = expectContract(envelope(z.unknown()), body);
  if (data === undefined) throw new Error('value does not match the contract:\n  data: Required');
  return data;
}
