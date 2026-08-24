import { TypeKind } from './pgTreeView';

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The "data" of a data type is its definition detail: enum labels, composite
 * attributes, the domain's base type and constraints, a range's subtype config.
 * Each variant is a plain SELECT so the type viewer reuses the table viewer's
 * paging, sorting and export unchanged.
 */
export function typeDetailSql(schema: string, name: string, kind: TypeKind | undefined): string {
    const where = `n.nspname = ${lit(schema)} AND t.typname = ${lit(name)}`;
    switch (kind) {
        case 'enum':
            return `
                SELECT (row_number() OVER (ORDER BY e.enumsortorder))::int AS sort_order,
                       e.enumlabel AS label
                FROM pg_enum e
                JOIN pg_type t ON t.oid = e.enumtypid
                JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE ${where}
                ORDER BY e.enumsortorder`;
        case 'composite':
            return `
                SELECT a.attnum::int AS position, a.attname AS attribute,
                       format_type(a.atttypid, a.atttypmod) AS data_type,
                       COALESCE((SELECT co.collname FROM pg_collation co
                                 WHERE co.oid = a.attcollation AND co.collname <> 'default'), '') AS collation,
                       COALESCE(col_description(c.oid, a.attnum), '') AS comment
                FROM pg_type t
                JOIN pg_namespace n ON n.oid = t.typnamespace
                JOIN pg_class c ON c.oid = t.typrelid
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                WHERE ${where}
                ORDER BY a.attnum`;
        case 'domain':
            return `
                SELECT format_type(t.typbasetype, t.typtypmod) AS base_type,
                       NOT t.typnotnull AS nullable,
                       COALESCE(t.typdefault, '') AS default_value,
                       COALESCE((SELECT string_agg(co.conname || ' ' || pg_get_constraintdef(co.oid), '; '
                                                   ORDER BY co.conname)
                                 FROM pg_constraint co WHERE co.contypid = t.oid), '') AS constraints
                FROM pg_type t
                JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE ${where}`;
        case 'range':
            return `
                SELECT format_type(r.rngsubtype, NULL::integer) AS subtype,
                       COALESCE((SELECT opcname FROM pg_opclass WHERE oid = r.rngsubopc), '') AS subtype_opclass,
                       COALESCE((SELECT collname FROM pg_collation
                                 WHERE oid = r.rngcollation AND collname <> 'default'), '') AS collation,
                       CASE WHEN r.rngcanonical = 0 THEN '' ELSE r.rngcanonical::regproc::text END AS canonical,
                       CASE WHEN r.rngsubdiff = 0 THEN '' ELSE r.rngsubdiff::regproc::text END AS subtype_diff
                FROM pg_range r
                JOIN pg_type t ON t.oid = r.rngtypid
                JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE ${where}`;
        default:
            return `
                SELECT t.typname AS name, t.typcategory::text AS category,
                       t.typlen::int AS internal_length, t.typbyval AS passed_by_value,
                       t.typinput::regproc::text AS input_function,
                       t.typoutput::regproc::text AS output_function,
                       COALESCE(t.typdefault, '') AS default_value,
                       COALESCE(obj_description(t.oid, 'pg_type'), '') AS comment
                FROM pg_type t
                JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE ${where}`;
    }
}
