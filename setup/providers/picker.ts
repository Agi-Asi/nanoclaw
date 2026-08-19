/**
 * Agent-runtime picker options for setup's "Which agent runtime…" select.
 *
 * Order is Claude (the built-in default), then the hard-wired installable
 * list in the order the flow declares it (Codex, then Cursor last), then any
 * other already-wired provider. Installed-vs-not must not reshuffle that
 * order — otherwise a payload already on the barrel jumps ahead of one the
 * operator still has to install.
 *
 * An uninstalled installable keeps Codex's existing suffix: ` — installs now`
 * after the credential hint. Do not restyle that string.
 */
export interface AgentRuntimeOption {
  value: string;
  label: string;
  hint: string;
}

export function buildAgentRuntimePickerOptions(opts: {
  installed: AgentRuntimeOption[];
  installable: readonly AgentRuntimeOption[];
  pinnedImage: boolean;
}): AgentRuntimeOption[] {
  const { installed, installable, pinnedImage } = opts;
  const note = (value: string, hint: string): string =>
    pinnedImage && value !== 'claude' ? `${hint} — ⚠ not in the pre-built image; needs a local build` : hint;

  const installedByValue = new Map(installed.map((entry) => [entry.value, entry]));
  const options: AgentRuntimeOption[] = [];
  const seen = new Set<string>();
  const push = (entry: AgentRuntimeOption) => {
    if (seen.has(entry.value)) return;
    seen.add(entry.value);
    options.push({ ...entry, hint: note(entry.value, entry.hint) });
  };

  const claude = installedByValue.get('claude');
  if (claude) push(claude);

  for (const prov of installable) {
    const wired = installedByValue.get(prov.value);
    if (wired) {
      push(wired);
    } else {
      push({ ...prov, hint: `${prov.hint} — installs now` });
    }
  }

  for (const entry of installed) {
    if (entry.value === 'claude') continue;
    push(entry);
  }

  return options;
}
