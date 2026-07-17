import { fieldAuditValue } from '@/lib/fieldAuditValue';

it('redacts embedded images to a bounded, verifiable audit marker', () => {
  const dataUri = `data:image/png;base64,${'A'.repeat(100_000)}`;
  const audit = fieldAuditValue(dataUri);

  expect(audit).toMatch(/^\[embedded image redacted; bytes=\d+; sha256=[a-f0-9]{64}\]$/);
  expect(audit).not.toContain('AAAA');
  expect(audit.length).toBeLessThan(200);
});

it('bounds unexpectedly large non-image values below the MySQL TEXT limit', () => {
  const audit = fieldAuditValue('x'.repeat(100_000));

  expect(audit.length).toBeLessThan(65_535);
  expect(Buffer.byteLength(audit, 'utf8')).toBeLessThanOrEqual(60_000);
  expect(audit).toContain('[truncated; chars=100000; bytes=100000; sha256=');
});

it('bounds multibyte values by UTF-8 bytes rather than JavaScript characters', () => {
  const audit = fieldAuditValue('😀'.repeat(20_000));

  expect(Buffer.byteLength(audit, 'utf8')).toBeLessThanOrEqual(60_000);
  expect(audit).not.toContain('\uFFFD');
  expect(audit).toContain('bytes=80000');
});
