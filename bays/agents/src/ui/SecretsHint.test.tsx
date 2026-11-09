import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SecretsHint } from './SecretsHint';

describe('SecretsHint', () => {
  it('shows nothing when the server connection is gone, without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // A plain function: vi.fn handles the promises it returns itself.
      const api = { secrets: () => Promise.reject(new Error('Connection closed')) };
      const { container } = render(<SecretsHint api={api} id="hint" />);
      await new Promise((r) => setTimeout(r, 10));
      expect(container.textContent).toBe('');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
