/**
 * Wiring tests for the /add-audit skill's two core edits — they go red if
 * either edit is deleted or drifts:
 *
 *  1. src/cli/dispatch.ts — the exported dispatch must be the composed
 *     `withAudit(dispatchInner)` (AST check: only the definition-site
 *     composition covers both transports AND the in-module approved replay).
 *  2. src/cli/resources/index.ts — the audit resource must register through
 *     the real barrel (behavior check), stay OFF the group-scope allowlist,
 *     and leave guard conformance clean.
 *
 * Plus the emit invariant the module's discipline rests on: emitAuditEvent
 * appears only in src/audit/ and *.audit.ts adapter files.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Same production barrels the guard conformance test loads (mirrors
// src/guard/conformance.test.ts).
import './cli/commands/index.js';
import './modules/index.js';
import './cli/delivery-action.js';
import './cli/dispatch.js';

import { commandGuard, GROUP_SCOPE_RESOURCES, lookup } from './cli/registry.js';
import { getApprovalHandler } from './modules/approvals/primitive.js';
import { listGuardedActions } from './guard/index.js';

describe('audit resource registration (barrel wiring)', () => {
  it('registers audit-list through the real resource barrel', () => {
    const cmd = lookup('audit-list');
    expect(cmd).toBeDefined();
    expect(cmd?.action).toBe('audit.list');
    expect(cmd?.access).toBe('open');
  });

  it('derives a guard-catalog entry for the audit command', () => {
    const guard = commandGuard('audit-list');
    expect(guard.action).toBe('audit.list');
  });

  it('is NOT on the group-scope allowlist — group-scoped agents fail closed', () => {
    expect(GROUP_SCOPE_RESOURCES.has('audit')).toBe(false);
  });

  it('leaves guard conformance clean with the audit resource registered', () => {
    // The invariant guard conformance checks: every holding action pairs with a
    // registered approve continuation. audit.list is `open` (never holds), so
    // registering the resource can't introduce a gap — this pins that.
    const dangling = listGuardedActions()
      .filter((spec) => spec.grantActionName)
      .filter((spec) => !getApprovalHandler(spec.grantActionName as string));
    expect(dangling.map((s) => s.action)).toEqual([]);
  });
});

describe('dispatch composition (AST wiring)', () => {
  const source = fs.readFileSync(path.resolve('src/cli/dispatch.ts'), 'utf8');
  const sf = ts.createSourceFile('dispatch.ts', source, ts.ScriptTarget.Latest, true);

  const hasExportModifier = (node: ts.HasModifiers): boolean =>
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  let importsWithAudit = false;
  let innerDeclaredUnexported = false;
  let exportsWrappedDispatch = false;
  let exportsUnwrappedDispatchFn = false;

  sf.forEachChild((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === './dispatch.audit.js'
    ) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === 'withAudit')) {
        importsWithAudit = true;
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'dispatchInner') {
      innerDeclaredUnexported = !hasExportModifier(node);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'dispatch' && hasExportModifier(node)) {
      exportsUnwrappedDispatchFn = true;
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === 'dispatch' &&
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === 'withAudit' &&
          decl.initializer.arguments.length === 1 &&
          ts.isIdentifier(decl.initializer.arguments[0]) &&
          decl.initializer.arguments[0].text === 'dispatchInner'
        ) {
          exportsWrappedDispatch = true;
        }
      }
    }
  });

  it('imports withAudit from the audit adapter', () => {
    expect(importsWithAudit).toBe(true);
  });

  it('keeps the inner dispatcher unexported (the guarded path is the only path)', () => {
    expect(innerDeclaredUnexported).toBe(true);
  });

  it('exports dispatch as withAudit(dispatchInner)', () => {
    expect(exportsWrappedDispatch).toBe(true);
    expect(exportsUnwrappedDispatchFn).toBe(false);
  });
});

describe('emit invariant', () => {
  it('emitAuditEvent appears only in src/audit/ and *.audit.ts files', () => {
    const srcRoot = path.resolve('src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(srcRoot, full).split(path.sep).join('/');
        if (rel === 'audit-wiring.test.ts') continue; // this file names the symbol
        if (rel.startsWith('audit/')) continue;
        if (/\.audit(\.test)?\.ts$/.test(rel)) continue;
        if (fs.readFileSync(full, 'utf8').includes('emitAuditEvent')) offenders.push(rel);
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
