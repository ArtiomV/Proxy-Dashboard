// Minimal ESLint config — focus on real bugs, not style.
// no-empty + allowEmptyCatch:false is intentional: per the refactor TZ,
// silent `catch (_) {}` blocks are bug-prone and need explicit logging.

module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'public/**', 'logs/**', 'tests/api/__snapshots__/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        // Node globals
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',  // global crypto exists in Node 19+
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['warn', 'smart'],
      'no-empty': ['warn', { allowEmptyCatch: false }],
    },
  },
  {
    // Test files run on ESM via vitest — different sourceType + globals
    files: ['tests/**/*.test.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        describe: 'readonly', it: 'readonly', expect: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
];
