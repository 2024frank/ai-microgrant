process.env.DATABASE_HOST              = 'localhost';
process.env.DATABASE_PORT              = '3306';
process.env.DATABASE_USERNAME          = 'test';
process.env.DATABASE_PASSWORD          = 'test';
process.env.DATABASE_NAME              = 'test';
process.env.ANTHROPIC_API_KEY          = 'test-key';
process.env.NEXT_PUBLIC_APP_URL        = 'http://localhost:3000';
process.env.SOURCE_BUILDER_ENVIRONMENT_ID = 'env-test';
process.env.SOURCE_BUILDER_VAULT_ID       = 'vault-test';
process.env.CRON_SECRET                = 'test-cron-secret';
process.env.ADMIN_EMAIL                = 'admin@test.local';

jest.mock('@/lib/firebase-admin', () => ({
  adminAuth: { verifyIdToken: jest.fn() },
}));

jest.mock('@/lib/db', () => {
  const poolQuery = jest.fn();
  const connQuery = jest.fn().mockResolvedValue([{ affectedRows: 1 }]);
  const mockConn  = {
    query:            connQuery,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit:           jest.fn().mockResolvedValue(undefined),
    rollback:         jest.fn().mockResolvedValue(undefined),
    release:          jest.fn(),
  };
  return {
    __esModule: true,
    default: {
      query:         poolQuery,
      getConnection: jest.fn().mockResolvedValue(mockConn),
    },
    mockConn,
  };
});
