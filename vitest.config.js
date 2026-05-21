// Vitest config — keeps tests isolated from prod data:
//   - fileParallelism=false so all suites share the process, but each
//     suite gets its own temp DB via tests/_helpers/app.js (no port
//     conflicts, no cross-suite DB pollution).
//   - NODE_ENV=test is the signal server.js checks to skip `app.listen`
//     and all cron/Telegram side effects.
//   - testTimeout is generous: cold-loading server.js (the 11k-line
//     monolith + migrations) on first require can take a few seconds.

export default {
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 20000,
    fileParallelism: false,        // serial suites; each suite owns its DB
    include: ['tests/**/*.test.js'],
    env: { NODE_ENV: 'test' },
    setupFiles: ['./tests/_helpers/setup-env.js'],
  },
};
