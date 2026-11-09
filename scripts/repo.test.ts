import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');

describe('repository conventions', () => {
  it('has CLAUDE.md import AGENTS.md instead of repeating it', () => {
    const claude = read('CLAUDE.md');
    expect(claude).toMatch(/^@AGENTS\.md$/m);
    expect(claude).not.toContain('## Regeln');
  });

  it('keeps layout and commands in the README only', () => {
    expect(read('README.md')).toContain('| `pnpm test:e2e`');
    expect(read('AGENTS.md')).not.toContain('| `pnpm test:e2e`');
  });
});
