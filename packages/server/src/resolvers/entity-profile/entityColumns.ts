/**
 * Which columns of an entity are profiled, and with which statistics, derived
 * from MJ metadata only.
 *
 * The caller never supplies a column list. Profiled columns are the entity's
 * base columns read through its BaseView: virtual fields (view-only joins such as
 * related-entity names and MJ's `Root*` functions) and MJ's `__mj*` plumbing
 * columns are left out. With base columns only, the optimizer removes the view's
 * joins, so the BaseView costs what the base table does; selecting a virtual
 * field made self-referencing views 6–24× slower (measurements §3, §10).
 *
 * Each column gets a {@link ColumnKind}, which decides its aggregates:
 * - `numeric`: MIN, MAX, zero count, negative count.
 * - `date`: MIN/MAX without placeholders, placeholder count, share at MIN/MAX.
 * - `text`: blank count and length, for bounded `varchar(n)`/`nvarchar(n)` only.
 * - `other`: coverage only. This includes long text (`max`, `text`, JSON, XML):
 *   blank and length checks decompress every large value, which took one
 *   7.9M-row table from 9.8 s to over 60 s (measurements §10, finding 2).
 */

import type { EntityFieldInfo, EntityInfo } from '@memberjunction/core';

export type ColumnKind = 'numeric' | 'date' | 'text' | 'other';

export interface ProfiledColumn {
    Name: string;
    Type: string;
    Kind: ColumnKind;
}

const NUMERIC_TYPES = new Set([
    'int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real',
    'integer', 'double precision', 'double', 'serial', 'bigserial', 'smallserial', 'int2', 'int4', 'int8',
    'float4', 'float8',
]);

const DATE_TYPES = new Set([
    'date', 'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime',
    'timestamp', 'timestamptz', 'timestamp with time zone', 'timestamp without time zone',
]);

const BOUNDABLE_TEXT_TYPES = new Set([
    'char', 'nchar', 'varchar', 'nvarchar', 'character', 'character varying', 'bpchar',
]);

function baseType(sqlType: string): string {
    return sqlType.trim().toLowerCase().replace(/\(.*$/, '').trim();
}

export function IsDateType(sqlType: string): boolean {
    return DATE_TYPES.has(baseType(sqlType));
}

/**
 * The statistics a column gets. `length` is MJ's `EntityField.Length`: -1 for
 * `max`, 0 or null when the type has no declared length.
 */
export function ColumnKindFor(sqlType: string, length: number | null | undefined): ColumnKind {
    const type = baseType(sqlType);
    if (NUMERIC_TYPES.has(type)) return 'numeric';
    if (DATE_TYPES.has(type)) return 'date';
    if (BOUNDABLE_TEXT_TYPES.has(type) && (length ?? 0) > 0) return 'text';
    return 'other';
}

export function ProfiledColumns(entity: EntityInfo): ProfiledColumn[] {
    return entity.Fields
        .filter(f => !f.IsVirtual && !f.Name.startsWith('__mj'))
        .map(f => ({ Name: f.Name, Type: f.Type, Kind: ColumnKindFor(f.Type, f.Length) }));
}

/** The entity's primary-key column names, which the hash and semi-join samples key on. */
export function PrimaryKeyNames(entity: EntityInfo): string[] {
    return entity.PrimaryKeys.map((f: EntityFieldInfo) => f.Name);
}

/**
 * A signature of the profiled columns. A cached profile whose signature no longer
 * matches MJ's current metadata (a column added, removed or retyped by CodeGen)
 * is recomputed.
 */
export function SchemaSignature(columns: ProfiledColumn[]): string {
    return columns.map(c => `${c.Name}:${c.Type}:${c.Kind}`).join('|');
}
