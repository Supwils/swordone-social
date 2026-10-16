// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** `no-restricted-imports` options for a contract file; `outside` matches a specifier leaving src/contract/. */
function contractImports(outside) {
  return {
    patterns: [
      {
        regex: '^(?!zod$|\\.\\.?/)',
        message: 'Contract files import only zod and sibling contract files.',
      },
      { regex: outside, message: 'Contract files must not reach outside src/contract/.' },
    ],
  };
}

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
      },
    },
    rules: {
      // Allow `_`-prefixed unused vars (intentional, common in catch blocks)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The codebase relies on `unknown` casts at API boundaries — `any` is forbidden
      '@typescript-eslint/no-explicit-any': 'error',
      // Allow non-null assertions in tests; tighten elsewhere
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Empty catch blocks are common for fire-and-forget telemetry / cleanup
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The API contract is copied verbatim to client/ and mcp/, whose builds never
    // see the rest of the server: it may import only `zod` and sibling contract
    // files. This is a hint — `src/contract/contract.imports.test.ts` resolves
    // every specifier and is the authoritative check (it also rejects directory
    // imports, which a pattern cannot see).
    files: ['src/contract/*.ts'],
    ignores: ['src/contract/**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', contractImports('^\\.\\./')] },
  },
  {
    files: ['src/contract/*/*.ts'],
    ignores: ['src/contract/**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', contractImports('^\\.\\./\\.\\./')] },
  },
  {
    // Test files: relax a few rules
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
