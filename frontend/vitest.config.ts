import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
        // Wall-clock load tests are timing-sensitive and flaky on shared CI
        // runners. Run them on demand with `npm run test:load` (#123).
        exclude: [...configDefaults.exclude, 'tests/load-endpoints.test.ts'],
        globals: true,
        coverage: {
            reporter: ['text', 'json-summary', 'lcov'],
            reportOnFailure: true,
            thresholds: {
                lines: 55,
                functions: 55,
                branches: 55,
                statements: 55,
            },
        },
    },
});
