import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
      'docs/api/**',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The core also runs on a server without a display (Phase 8, docs/roadmap.md).
    files: [
      'packages/host/**',
      'packages/bridge/**',
      'packages/relay/**',
      'apps/server/**',
      'apps/relay/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'electron', message: 'The core and the server run without Electron.' }] },
      ],
    },
  },
);
