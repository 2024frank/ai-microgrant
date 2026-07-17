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

  it('releases only failed schedule slots and replaces the old unique key last', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/0014_scheduler_retry_slots.sql'),
      'utf8',
    );

    expect(migration).toContain('reserved_schedule_slot DATETIME GENERATED ALWAYS AS');
    expect(migration).toContain("status IN (''running'',''completed'',''stopped'')");
    expect(migration).toContain("THEN schedule_slot ELSE NULL END) VIRTUAL'");
    expect(migration).toContain(
      'UNIQUE KEY uq_agent_runs_reserved_schedule_slot (source_id, reserved_schedule_slot)',
    );

    const replacementIndex = migration.indexOf(
      'ALTER TABLE agent_runs ADD UNIQUE KEY uq_agent_runs_reserved_schedule_slot',
    );
    const oldIndexDrop = migration.indexOf(
      'ALTER TABLE agent_runs DROP INDEX uq_agent_runs_schedule_slot',
    );
    expect(replacementIndex).toBeGreaterThan(-1);
    expect(oldIndexDrop).toBeGreaterThan(replacementIndex);
  });

  it('keeps moderation schema expansion free of pre-promotion feed mutations', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/0012_communityhub_moderation.sql'),
      'utf8',
    );

    expect(migration).toContain('communityhub_moderation_status');
    expect(migration).not.toMatch(/UPDATE raw_events\s+SET status\s*=\s*'submitted'/i);
  });

  it('matches the published-update foreign key to the live raw event id type', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/0013_communityhub_update_outbox.sql'),
      'utf8',
    );

    expect(migration).toContain("TABLE_NAME = 'raw_events'");
    expect(migration).toContain("COLUMN_NAME = 'id'");
    expect(migration).toContain("'raw_event_id ', @raw_event_id_type, ' NOT NULL,'");
    expect(migration).not.toContain('raw_event_id          INT UNSIGNED NOT NULL');
  });
});
