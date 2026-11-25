import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScenario } from '../src/index.js';

const scenario = {
  dirtyPages: [
    { id: 'P1', pageLsn: 120, age: 90, flushedAt: 4 },
    { id: 'P2', pageLsn: 110, age: 40 },
  ],
  wal: { records: [100, 110, 120], durableLsn: 120 },
  walPersistencePoints: [{ lsn: 120, at: 1 }],
  barriers: [
    { id: 'BW', at: 2, scope: 'wal', targets: ['dev0'], acks: ['dev0'] },
    { id: 'BD', at: 5, scope: 'data', targets: ['dev0'], acks: ['dev0'] },
  ],
  checkpoints: [{ id: 'CP1', at: 6 }],
};

test('checkpoint 计算出的记录只包含真正安全的页', () => {
  const report = analyzeScenario(scenario);
  const checkpoint = report.checkpoints[0];
  assert.deepEqual(checkpoint.safePages, ['P1']);
  assert.equal(checkpoint.record.checkpointId, 'CP1');
  assert.deepEqual(checkpoint.record.safePages, ['P1']);

  const p2 = checkpoint.unsafePages.find((p) => p.pageId === 'P2');
  assert.ok(p2.reasons.includes('PAGE_NOT_FLUSHED'));
});

test('checkpoint 漏记安全页时给出 warning', () => {
  const report = analyzeScenario({
    ...scenario,
    checkpoints: [{ id: 'CP1', at: 6, pages: [] }],
  });
  assert.deepEqual(report.checkpoints[0].omittedSafePages, ['P1']);
  assert.ok(
    report.violations.some(
      (v) => v.code === 'CHECKPOINT_SAFE_PAGES_OMITTED',
    ),
  );
});

test('checkpoint 把 WAL 尚未持久化的页记为安全页时报错', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P3', pageLsn: 300, age: 90, flushedAt: 3 }],
    wal: { records: [100, 300], durableLsn: 200 },
    walPersistencePoints: [{ lsn: 200, at: 1 }],
    barriers: [
      { id: 'BW', at: 2, scope: 'wal', targets: ['dev0'], acks: ['dev0'] },
      { id: 'BD', at: 4, scope: 'data', targets: ['dev0'], acks: ['dev0'] },
    ],
    checkpoints: [{ id: 'CP1', at: 5, pages: ['P3'] }],
  });
  const violation = report.violations.find(
    (v) => v.code === 'CHECKPOINT_RECORDS_UNSAFE_PAGE',
  );
  assert.ok(violation);
  assert.ok(violation.reasons.includes('WAL_NOT_DURABLE_AT_CHECKPOINT'));
});
