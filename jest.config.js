/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react' } }] },
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  testPathIgnorePatterns: ['/node_modules/', '/node_modules\\.nosync/', '/\\.claude/'],
  modulePathIgnorePatterns: ['<rootDir>/node_modules.nosync', '<rootDir>/.claude'],
  watchPathIgnorePatterns: ['<rootDir>/node_modules.nosync', '<rootDir>/.claude'],
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
  // Each test file manages its own mock state via beforeEach resets
  restoreMocks: false,
  clearMocks: false,
  // Suppress "Force exiting" notice from fire-and-forget async in route handlers
  openHandlesTimeout: 100,
  forceExit: true,
};
