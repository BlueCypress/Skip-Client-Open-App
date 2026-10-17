/**
 * Splits a statement's leading `WITH` list from its main statement, keeping
 * every byte of the original text.
 *
 * This replaces `SQLParser.ExtractCTEs`, whose AST path re-emits SQL instead of
 * slicing it — and re-emits some of it wrongly: `FROM (VALUES …) AS v(n)` came
 * back as `AS [v(n)]` and `DATEADD(MONTH, …)` as `DATEADD([MONTH], …)`, so the
 * profiler reported `'error'` for a correct query (E4 P-1). Slicing cannot
 * change the SQL, and it needs no particular MJ version, so it works on clients
 * still running MJ 5.x.
 *
 * The scanner knows only what it must to find boundaries: string literals
 * (including `N'…'` and doubled quotes), quoted identifiers (`"…"`, `[…]`),
 * line and block comments, PostgreSQL dollar quoting, and parenthesis depth.
 */

export interface LeadingCTESplit {
    /** Each definition verbatim: `name [(columns)] AS [NOT] [MATERIALIZED] (body)`. */
    CTEDefinitions: string[];
    MainStatement: string;
    Recursive: boolean;
}

/**
 * Returns the split, or `null` when the statement has no leading `WITH` or its
 * `WITH` list cannot be read with confidence.
 */
export function SplitLeadingCTEs(sql: string): LeadingCTESplit | null {
    let index = skipTrivia(sql, 0);
    if (!matchesWord(sql, index, 'WITH')) return null;
    index = skipTrivia(sql, index + 4);
    let recursive = false;
    if (matchesWord(sql, index, 'RECURSIVE')) {
        recursive = true;
        index = skipTrivia(sql, index + 9);
    }
    const definitions: string[] = [];
    for (;;) {
        const end = readDefinition(sql, index);
        if (end === null) return null;
        definitions.push(sql.slice(index, end).trim());
        index = skipTrivia(sql, end);
        if (sql[index] !== ',') break;
        index = skipTrivia(sql, index + 1);
    }
    const main = sql.slice(index).trim();
    return main ? { CTEDefinitions: definitions, MainStatement: main, Recursive: recursive } : null;
}

/** Reads one `name [(cols)] AS [NOT] [MATERIALIZED] ( … )` and returns the index after its closing parenthesis. */
function readDefinition(sql: string, start: number): number | null {
    let index = readIdentifier(sql, start);
    if (index === null) return null;
    index = skipTrivia(sql, index);
    if (sql[index] === '(') {
        const close = matchingParen(sql, index);
        if (close === null) return null;
        index = skipTrivia(sql, close + 1);
    }
    if (!matchesWord(sql, index, 'AS')) return null;
    index = skipTrivia(sql, index + 2);
    if (matchesWord(sql, index, 'NOT')) index = skipTrivia(sql, index + 3);
    if (matchesWord(sql, index, 'MATERIALIZED')) index = skipTrivia(sql, index + 12);
    if (sql[index] !== '(') return null;
    const close = matchingParen(sql, index);
    return close === null ? null : close + 1;
}

function readIdentifier(sql: string, index: number): number | null {
    const char = sql[index];
    if (char === '"') return skipQuoted(sql, index, '"');
    if (char === '[') return skipQuoted(sql, index, ']');
    const match = /^[A-Za-z_][\w$#@]*/.exec(sql.slice(index));
    return match ? index + match[0].length : null;
}

/** Index of the parenthesis closing the one at `open`, skipping anything quoted or commented. */
function matchingParen(sql: string, open: number): number | null {
    let depth = 0;
    let index = open;
    while (index < sql.length) {
        const skipped = skipOpaque(sql, index);
        if (skipped !== index) {
            index = skipped;
            continue;
        }
        if (sql[index] === '(') depth++;
        if (sql[index] === ')' && --depth === 0) return index;
        index++;
    }
    return null;
}

/** Skips whitespace and comments. */
function skipTrivia(sql: string, index: number): number {
    for (;;) {
        while (index < sql.length && /\s/.test(sql[index])) index++;
        if (sql.startsWith('--', index) || sql.startsWith('/*', index)) {
            index = skipOpaque(sql, index);
            continue;
        }
        return index;
    }
}

/** If a string, quoted identifier, comment or dollar-quoted body starts at `index`, returns the index after it. */
function skipOpaque(sql: string, index: number): number {
    const char = sql[index];
    if (char === "'") return skipQuoted(sql, index, "'");
    if ((char === 'N' || char === 'n' || char === 'E' || char === 'e') && sql[index + 1] === "'") return skipQuoted(sql, index + 1, "'");
    if (char === '"') return skipQuoted(sql, index, '"');
    if (char === '[') return skipQuoted(sql, index, ']');
    if (sql.startsWith('--', index)) {
        const newline = sql.indexOf('\n', index);
        return newline === -1 ? sql.length : newline + 1;
    }
    if (sql.startsWith('/*', index)) return skipBlockComment(sql, index);
    if (char === '$') {
        const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
        if (tag) {
            const close = sql.indexOf(tag[0], index + tag[0].length);
            return close === -1 ? sql.length : close + tag[0].length;
        }
    }
    return index;
}

/** Skips a quoted run whose closing character is doubled to escape it. */
function skipQuoted(sql: string, open: number, close: string): number {
    let index = open + 1;
    while (index < sql.length) {
        if (sql[index] === close) {
            if (sql[index + 1] === close) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index++;
    }
    return sql.length;
}

/** Block comments nest in PostgreSQL; nesting is harmless to honour on SQL Server. */
function skipBlockComment(sql: string, open: number): number {
    let depth = 0;
    let index = open;
    while (index < sql.length) {
        if (sql.startsWith('/*', index)) {
            depth++;
            index += 2;
        } else if (sql.startsWith('*/', index)) {
            depth--;
            index += 2;
            if (depth === 0) return index;
        } else {
            index++;
        }
    }
    return sql.length;
}

function matchesWord(sql: string, index: number, word: string): boolean {
    return sql.slice(index, index + word.length).toUpperCase() === word
        && !/[\w$#@]/.test(sql[index + word.length] ?? '');
}
