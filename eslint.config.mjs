import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'release/**', 'dist/**', 'build/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  { files: ['src/main/**/*.js', 'src/core/**/*.js', 'tests/**/*.js', 'playwright.config.js', 'electron-builder.config.js'], languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } } },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module', globals: { ...globals.node } } },
  { files: ['tests/e2e/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['src/renderer/**/*.js'], languageOptions: { sourceType: 'module', globals: { ...globals.browser, ron: 'readonly' } } },
  { rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] } },
];
