import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { APP_TABLES } from './tables';

/**
 * The platform foreign keys (migration 0006), read from the schema's
 * `foreignKey()` declarations so the orphan report and the validate step can
 * never drift from what the migration created. All are single-column,
 * ON DELETE NO ACTION, and were added NOT VALID.
 */
export interface ForeignKeySpec {
  name: string;
  table: string;
  column: string;
  parentTable: string;
  parentColumn: string;
}

export const FOREIGN_KEYS: readonly ForeignKeySpec[] = APP_TABLES.flatMap((table) =>
  getTableConfig(table).foreignKeys.map((fk): ForeignKeySpec => {
    const ref = fk.reference();
    if (ref.columns.length !== 1 || ref.foreignColumns.length !== 1) {
      throw new Error(`foreign key ${fk.getName()} must be single-column`);
    }
    return {
      name: fk.getName(),
      table: getTableName(table),
      column: ref.columns[0].name,
      parentTable: getTableName(ref.foreignTable),
      parentColumn: ref.foreignColumns[0].name,
    };
  }),
).sort((a, b) => a.name.localeCompare(b.name));

/** The slice of a `pg` Client the checks need — lets a test record every statement. */
export interface SqlRunner {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** Count child rows whose non-NULL FK value names no parent row. */
export function orphanCountSql(fk: ForeignKeySpec): string {
  const col = `c.${q(fk.column)}`;
  return (
    `SELECT count(*)::int AS n FROM ${q(fk.table)} c WHERE ${col} IS NOT NULL ` +
    `AND NOT EXISTS (SELECT 1 FROM ${q(fk.parentTable)} p WHERE p.${q(fk.parentColumn)} = ${col})`
  );
}

export interface ForeignKeyStatus {
  fk: ForeignKeySpec;
  orphans: number;
  /** The constraint exists in the target database (0006 applied). */
  present: boolean;
  /** `pg_constraint.convalidated` — false while it is still NOT VALID. */
  validated: boolean;
}

/**
 * Per-constraint orphan counts plus each constraint's state, inside a
 * `READ ONLY` transaction that is always rolled back: the database itself
 * refuses any write this function could attempt.
 */
export async function inspectForeignKeys(runner: SqlRunner): Promise<ForeignKeyStatus[]> {
  await runner.query('BEGIN READ ONLY');
  try {
    const ro = await runner.query('SHOW transaction_read_only');
    if (ro.rows[0]?.transaction_read_only !== 'on') {
      throw new Error('orphan check: transaction is not read-only; refusing to continue');
    }
    const { rows } = await runner.query(
      "SELECT conname, convalidated FROM pg_constraint WHERE contype = 'f' " +
        "AND connamespace = 'public'::regnamespace",
    );
    const state = new Map(rows.map((r) => [String(r.conname), r.convalidated === true]));
    const out: ForeignKeyStatus[] = [];
    for (const fk of FOREIGN_KEYS) {
      const res = await runner.query(orphanCountSql(fk));
      out.push({
        fk,
        orphans: Number(res.rows[0]?.n ?? 0),
        present: state.has(fk.name),
        validated: state.get(fk.name) ?? false,
      });
    }
    return out;
  } finally {
    await runner.query('ROLLBACK');
  }
}

export function formatStatus(s: ForeignKeyStatus): string {
  const state = !s.present ? 'missing' : s.validated ? 'valid' : 'not valid';
  return `${s.fk.name.padEnd(34)} ${String(s.orphans).padStart(8)} orphan(s)  [${state}]`;
}

export interface ValidateResult {
  name: string;
  action: 'validated' | 'already-valid';
}

/**
 * `ALTER TABLE … VALIDATE CONSTRAINT` for each constraint still NOT VALID.
 * The caller must have checked `inspectForeignKeys` is clean: validation of a
 * constraint with orphans fails, and this function does not re-check.
 */
export async function validateForeignKeys(
  runner: SqlRunner,
  statuses: readonly ForeignKeyStatus[],
): Promise<ValidateResult[]> {
  const out: ValidateResult[] = [];
  for (const s of statuses) {
    if (!s.present) throw new Error(`constraint ${s.fk.name} does not exist; apply 0006 first`);
    if (s.validated) {
      out.push({ name: s.fk.name, action: 'already-valid' });
      continue;
    }
    await runner.query(`ALTER TABLE ${q(s.fk.table)} VALIDATE CONSTRAINT ${q(s.fk.name)}`);
    out.push({ name: s.fk.name, action: 'validated' });
  }
  return out;
}
