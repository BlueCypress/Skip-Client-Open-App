/**
 * Tier 1 of column typing: resolve result columns against MJ entity metadata.
 *
 * This is the authoritative tier. `MJQueryEntityServer` already solves the same
 * problem for query sync, and the machinery is reused rather than
 * reimplemented — `EnrichFieldTypesFromEntityMetadata` matches parsed SELECT
 * columns against `EntityInfo.Fields` and yields a real `sqlBaseType`.
 *
 * It is also the **only** tier that can supply sensitivity metadata, because
 * sensitivity is a property of the source field rather than of the returned
 * value. Columns this tier cannot reach — expressions, `SELECT *`, anything
 * sourced from a CTE — fall through to value inspection for typing and are
 * governed by name-shape default-deny for disclosure.
 *
 * The whole module is failure-tolerant by construction: any error resolving
 * metadata yields an empty hint map, which costs precision and closes the
 * disclosure gate further. It never sinks the profile.
 *
 * `query-extraction` is not re-exported from `@memberjunction/core-entities-server`'s
 * root barrel at 5.51.0, so it is deep-imported. That coupling is deliberately
 * confined to this one file.
 */

import { LogError } from '@memberjunction/core';
import type { IMetadataProvider, EntityFieldInfo } from '@memberjunction/core';
import { SQLParser } from '@memberjunction/sql-parser';
import type { SQLDialect } from '@memberjunction/sql-dialect';
import { EnrichFieldTypesFromEntityMetadata } from '@memberjunction/core-entities-server/dist/custom/query-extraction/index.js';
import type { ExtractedField } from '@memberjunction/core-entities-server/dist/custom/query-extraction/types.js';
import type { ColumnMetadataHint } from './columnTypes.js';

/**
 * Builds the metadata hint map for the given result columns.
 *
 * @param baseSQL      the rendered, uncapped candidate SQL
 * @param columnNames  the executed result's own column names — exact, and free
 *                     of the `SELECT *` / expression ambiguity that parsing the
 *                     SELECT list alone would carry
 */
export function resolveMetadataHints(
    baseSQL: string,
    columnNames: string[],
    dialect: SQLDialect,
    md: IMetadataProvider,
): Map<string, ColumnMetadataHint> {
    const hints = new Map<string, ColumnMetadataHint>();

    try {
        const tableRefs = SQLParser.ExtractTableRefs(baseSQL, dialect);
        if (tableRefs.length === 0) return hints;

        const selectColumns = SQLParser.ExtractSelectColumns(baseSQL, dialect);
        const seeds: ExtractedField[] = columnNames.map(name => ({
            name,
            description: '',
            type: 'string',
            optional: true,
        }));

        const enriched = EnrichFieldTypesFromEntityMetadata(seeds, selectColumns, tableRefs, md);

        for (const field of enriched) {
            if (!field.sqlBaseType) continue;
            hints.set(field.name, {
                sqlBaseType: field.sqlBaseType,
            });
        }
    } catch (error: unknown) {
        // Degrade to the sampled-values tier. Precision is lost; disclosure is
        // not widened, because a missing hint closes the domain gate rather than
        // opening it.
        LogError(`TestAndProfileQuerySQL: entity metadata typing unavailable — ${describe(error)}`);
        return new Map<string, ColumnMetadataHint>();
    }

    return hints;
}


function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
