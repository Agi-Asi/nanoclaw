# Remove /add-audit

Reverses every change the skill made. Safe to re-run even if some pieces are
already gone. Run from the NanoClaw project root.

## 1. Delete the copied files

```bash
rm -rf src/audit
rm -f src/cli/dispatch.audit.ts src/cli/dispatch.audit.test.ts
rm -f src/cli/resources/audit.ts
rm -f src/audit-wiring.test.ts
```

## 2. Revert the dispatch composition

In `src/cli/dispatch.ts`, delete (not comment out) the three edits the skill
made:

1. The import line: `import { withAudit } from './dispatch.audit.js';`
2. The composition block (comment + `export const dispatch = withAudit(dispatchInner);`)
3. Rename the dispatcher back — change `async function dispatchInner(` to
   `export async function dispatch(`

## 3. Unregister the resource

Delete the `import './audit.js';` line from `src/cli/resources/index.ts`.

## 4. Remove the settings

Delete the `AUDIT_ENABLED` and `AUDIT_RETENTION_DAYS` lines from `.env`.

## 5. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
```

## Day-files

`data/audit/*.ndjson` are the operator's records and are deliberately left in
place. To purge them too:

```bash
rm -rf data/audit
```

No dependency was added, nothing under `container/` was touched, and no DB
schema changed — there is nothing else to undo.
