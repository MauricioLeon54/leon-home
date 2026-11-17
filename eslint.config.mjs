import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['.build/**', '**/dist/**', '.venv/**', '.codegraph/**', '.code-review-graph/**', '.swiftpm/**', 'node_modules/**', 'private/**', 'rust/**/target/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map(config => ({ ...config, files: ['deploy/**/web/**/*.ts'] })),
  prettier,
  {
    files: ['**/*.{js,mjs,ts}'],
    plugins: { 'simple-import-sort': simpleImportSort },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-debugger': 'error',
      'object-shorthand': 'error',
      'no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: ['deploy/**/web/**/*.ts'],
    languageOptions: { globals: globals.browser, parserOptions: { project: ['./tsconfig.web.json', './tsconfig.worker.json'] } },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  { files: ['*.mjs', 'scripts/**/*.mjs', 'Tests/WebTests/**/*.mjs'], languageOptions: { globals: globals.node } },
];
