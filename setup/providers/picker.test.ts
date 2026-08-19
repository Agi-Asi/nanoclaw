import { describe, expect, it } from 'vitest';

import { buildAgentRuntimePickerOptions } from './picker.js';

const claude = {
  value: 'claude',
  label: 'Claude',
  hint: 'default — Anthropic subscription or API key',
};
const cursor = {
  value: 'cursor',
  label: 'Cursor',
  hint: 'Cursor — account sign-in or API key',
};
const codex = {
  value: 'codex',
  label: 'Codex',
  hint: 'OpenAI — ChatGPT subscription or API key',
};
const installable = [codex, cursor] as const;

describe('buildAgentRuntimePickerOptions', () => {
  it('keeps Claude, Codex, Cursor even when Cursor is already wired and Codex is not', () => {
    const options = buildAgentRuntimePickerOptions({
      installed: [claude, cursor],
      installable,
      pinnedImage: false,
    });
    expect(options.map((opt) => opt.value)).toEqual(['claude', 'codex', 'cursor']);
  });

  it('keeps Codex\'s existing suffix and matches that shape on Cursor', () => {
    const options = buildAgentRuntimePickerOptions({
      installed: [claude, cursor],
      installable,
      pinnedImage: false,
    });
    expect(options.find((opt) => opt.value === 'claude')!.hint).toBe(
      'default — Anthropic subscription or API key',
    );
    expect(options.find((opt) => opt.value === 'codex')!.hint).toBe(
      'OpenAI — ChatGPT subscription or API key — installs now',
    );
    expect(options.find((opt) => opt.value === 'cursor')!.hint).toBe(
      'Cursor — account sign-in or API key',
    );
  });

  it('puts Cursor last and suffixes installs-now the same way Codex does', () => {
    const options = buildAgentRuntimePickerOptions({
      installed: [claude],
      installable,
      pinnedImage: false,
    });
    expect(options.map((opt) => opt.value)).toEqual(['claude', 'codex', 'cursor']);
    expect(options.find((opt) => opt.value === 'codex')!.hint).toBe(
      'OpenAI — ChatGPT subscription or API key — installs now',
    );
    expect(options.find((opt) => opt.value === 'cursor')!.hint).toBe(
      'Cursor — account sign-in or API key — installs now',
    );
  });
});
