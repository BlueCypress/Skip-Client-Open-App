/**
 * @fileoverview Every bare module this package imports must be declared in its package.json.
 *
 * `@askskip/server` is loaded into an MJ host process, and for a long time it imported
 * `express`, `type-graphql` and `graphql-type-json` without declaring any of them. Under npm
 * that is invisible: npm builds a flat `node_modules`, so whatever the host pulled in was
 * visible to us by accident. pnpm gives a package only what it declares, so the same source
 * fails to resolve — `tsc` reports TS2307 for all three, and the package cannot be built as a
 * member of a pnpm workspace (which is how MJ 6.x and `mj dev workspace` install it).
 *
 * The defect is therefore not in the source; it is a gap between what the source imports and
 * what the manifest promises, and nothing in a normal build notices it. This test closes that
 * gap: it parses every file with the TypeScript compiler (not a regex — import-looking text in
 * a doc comment must not register) and asserts that each non-relative, non-builtin specifier
 * appears somewhere in the manifest.
 *
 * Scope is `src/` — the code `tsc` compiles and consumers install. Tests are deliberately left
 * out: a negative-path test may import a module that is meant not to resolve, and that is not a
 * manifest defect.
 *
 * A `peerDependency` satisfies it deliberately. Modules that must be the host's own copy —
 * the express app we mount a Router onto, the type-graphql metadata storage our resolver's
 * decorators write into, the graphql realm `GraphQLJSONObject` belongs to — are declared as
 * peers precisely so no second copy can be installed, and a peer is still a declaration.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNED_DIR = 'src';
const BUILTINS = new Set(builtinModules);

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
]);

/** Every .ts file under the given directory, recursively. */
function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    const visit = (current: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.name.endsWith('.ts')) found.push(full);
        }
    };
    visit(join(PACKAGE_ROOT, dir));
    return found;
}

/**
 * Collect the module specifiers a file actually imports, via the TypeScript parser:
 * static imports/re-exports, dynamic `import()`, `require()`, and `import('x')` types.
 */
function importedSpecifiers(file: string): string[] {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
            specifiers.push(node.argument.literal.text);
        } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
            const callee = node.expression;
            if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
                specifiers.push((node.arguments[0] as ts.StringLiteral).text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return specifiers;
}

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
function packageNameOf(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('package.json declares every module the package imports', () => {
    it('has no undeclared bare imports under src/', () => {
        const undeclared = new Map<string, Set<string>>();

        for (const file of sourceFiles(SCANNED_DIR)) {
            for (const specifier of importedSpecifiers(file)) {
                if (specifier.startsWith('.') || specifier.startsWith('#') || specifier.startsWith('node:')) continue;
                const name = packageNameOf(specifier);
                if (BUILTINS.has(name) || declared.has(name)) continue;
                if (!undeclared.has(name)) undeclared.set(name, new Set());
                undeclared.get(name)!.add(relative(PACKAGE_ROOT, file));
            }
        }

        const report = [...undeclared.entries()].map(([name, files]) => `${name} (imported by ${[...files].sort().join(', ')})`).sort();
        expect(report).toEqual([]);
    });

    it('declares the host-owned modules as peers so no second copy can be installed', () => {
        // express, type-graphql and graphql-type-json must resolve to the MJ host's own copies:
        // a Router from a different express, decorators writing into a different type-graphql
        // metadata storage, or a scalar from a different graphql realm all fail silently.
        for (const name of ['express', 'type-graphql', 'graphql-type-json']) {
            expect(Object.keys(manifest.peerDependencies ?? {}), `${name} should be a peerDependency`).toContain(name);
            expect(Object.keys(manifest.dependencies ?? {}), `${name} must not also be a hard dependency`).not.toContain(name);
        }
    });
});
