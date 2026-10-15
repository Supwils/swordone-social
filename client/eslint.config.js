// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLFormElement: 'readonly',
        AbortSignal: 'readonly',
        IntersectionObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        Event: 'readonly',
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // React 17+ JSX runtime — no `import React` needed
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Allow conditional hook deps (warning, not error) — too noisy for now
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  prettier,
  {
    // Lab boundary: outside src/features/lab, import only the index (`@/features/lab`).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/lab/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/lab/*'],
              message: 'Import the lab only through its index: "@/features/lab".',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
