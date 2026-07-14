import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('production migration compatibility', () => {
  it('uses a virtual scheduler lease column beside the cascading source foreign key', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/0008_scheduler_leases.sql'),
      'utf8',
    );

    expect(migration).toContain('running_source_id INT UNSIGNED GENERATED ALWAYS AS');
    expect(migration).toContain("END) VIRTUAL'");
    expect(migration).not.toContain("END) STORED'");
  });
});
