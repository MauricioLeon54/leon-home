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
      'object-shorthand': ['error', 'always', { avoidExplicitReturnArrows: true }],
      'arrow-body-style': ['error', 'as-needed'],
      'prefer-template': 'error',
      'prefer-object-spread': 'error',
      'no-array-constructor': 'error',
      'no-object-constructor': 'error',
      'prefer-exponentiation-operator': 'error',
      'no-useless-concat': 'error',
      'no-case-declarations': 'error',
      'spaced-comment': ['error', 'always', { exceptions: ['-', '+', '/'] }],
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-depth': ['warn', 3],
      'complexity': ['warn', 15],
      'max-params': ['warn', 4],
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
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'generic' }],
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true }],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true }],
      '@typescript-eslint/no-unsafe-type-assertion': 'warn',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      // Explicit Boolean conversions preserve legacy zero/empty-string/NaN behavior.
      'no-extra-boolean-cast': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  { files: ['*.mjs', 'scripts/**/*.mjs', 'Tests/WebTests/**/*.mjs'], languageOptions: { globals: globals.node } },
  {
    // Gerbera layout scripts: Duktape runs ES5 scripts that override common.js functions.
    files: ['sharing/storage/dlna-js/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: Object.fromEntries(
        ['config', 'addCdsObject', 'addContainerTree', 'BK_videoRoot', 'BK_videoAll', 'M_CONTENT_CLASS', 'OBJECT_TYPE_CONTAINER', 'UPNP_CLASS_VIDEO_ITEM'].map(name => [name, 'readonly'])
      ),
    },
    rules: { 'no-var': 'off', 'no-unused-vars': ['error', { vars: 'local', args: 'none' }] },
  },
];
