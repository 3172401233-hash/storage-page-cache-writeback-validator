import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScenario } from '../src/index.js';

test('部分 barrier 成功时状态为 partial，必须重新确认', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 100, age: 10 }],
    wal: { records: [100], durableLsn: 100 },
    barriers: [
      {
        id: 'B-partial',
        at: 1,
        targets: ['dev0', 'dev1'],
        acks: ['dev0'],
      },
    ],
  });

  const barrier = report.barriers[0];
  assert.equal(barrier.state, 'partial');
  assert.equal(barrier.confirmed, false);
  assert.equal(barrier.needsReconfirmation, true);
  assert.deepEqual(barrier.missingTargets, ['dev1']);
  assert.ok(
    report.violations.some(
      (v) => v.code === 'BARRIER_RECONFIRMATION_PENDING',
    ),
  );
});

test('barrier 完全失败时状态为 failed；重新确认全部 target 后才 confirmed', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 100, age: 10 }],
    wal: { records: [100], durableLsn: 100 },
    barriers: [
      {
        id: 'B-retry',
        at: 1,
        targets: ['dev0', 'dev1'],
        acks: [],
        reconfirm: [{ at: 3, acks: ['dev0', 'dev1'] }],
      },
    ],
  });

  const barrier = report.barriers[0];
  assert.equal(barrier.state, 'confirmed');
  assert.equal(barrier.confirmedAt, 3);
  assert.equal(barrier.needsReconfirmation, false);
  assert.equal(barrier.attemptCount, 2);
});

function checkpointScenario(dataBarrier, checkpointAt = 6) {
  return {
    dirtyPages: [{ id: 'P1', pageLsn: 100, age: 30 }],
    wal: {
      records: [{ lsn: 100, tx: 'T1', type: 'commit' }],
      durableLsn: 100,
    },
    walPersistencePoints: [{ lsn: 100, at: 1 }],
    barriers: [
      { id: 'BW', at: 2, scope: 'wal', targets: ['dev0'], acks: ['dev0'] },
      dataBarrier,
    ],
    flushAttempts: [{ id: 'F1', page: 'P1', startAt: 3, endAt: 4 }],
    checkpoints: [{ id: 'CP1', at: checkpointAt, pages: ['P1'] }],
  };
}

test('数据 barrier 已确认且顺序正确时，checkpoint 可以记录该安全页', () => {
  const report = analyzeScenario(
    checkpointScenario({
      id: 'BD',
      at: 5,
      scope: 'data',
      targets: ['dev0'],
      acks: ['dev0'],
    }),
  );

  assert.deepEqual(report.checkpoints[0].safePages, ['P1']);
  assert.deepEqual(report.checkpoints[0].unsafeClaimedPages, []);
  assert.equal(
    report.violations.some(
      (v) => v.code === 'CHECKPOINT_RECORDS_UNSAFE_PAGE',
    ),
    false,
  );
  assert.equal(report.ok, true);
});

test('barrier 失败时 checkpoint 不得把页记为安全页', () => {
  const report = analyzeScenario(
    checkpointScenario({
      id: 'BD',
      at: 5,
      scope: 'data',
      targets: ['dev0', 'dev1'],
      acks: [],
    }),
  );

  assert.deepEqual(report.checkpoints[0].safePages, []);
  assert.deepEqual(report.checkpoints[0].unsafeClaimedPages, ['P1']);
  const violation = report.violations.find(
    (v) => v.code === 'CHECKPOINT_RECORDS_UNSAFE_PAGE',
  );
  assert.ok(violation);
  assert.ok(violation.reasons.includes('DATA_BARRIER_NOT_CONFIRMED'));
  assert.equal(report.ok, false);
});

test('checkpoint 之后才重新确认成功，不能追溯让该 checkpoint 变安全', () => {
  const report = analyzeScenario(
    checkpointScenario(
      {
        id: 'BD',
        at: 5,
        scope: 'data',
        targets: ['dev0'],
        acks: [],
        reconfirm: [{ at: 7, acks: ['dev0'] }],
      },
      6,
    ),
  );

  assert.equal(report.barriers[1].state, 'confirmed');
  assert.equal(report.barriers[1].confirmedAt, 7);
  assert.deepEqual(report.checkpoints[0].safePages, []);
  assert.deepEqual(report.checkpoints[0].unsafeClaimedPages, ['P1']);
});

test('WAL barrier 落在数据落地之后，判定 barrier 顺序违规', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 100, age: 30 }],
    wal: { records: [100], durableLsn: 100 },
    walPersistencePoints: [{ lsn: 100, at: 1 }],
    flushAttempts: [
      { id: 'F1', page: 'P1', startAt: 2, endAt: 3 },
    ],
    barriers: [
      // 错误顺序：数据 t=3 已落地，WAL barrier t=5 才完成。
      { id: 'BW-late', at: 5, scope: 'wal', targets: ['dev0'], acks: ['dev0'] },
    ],
  });

  assert.ok(
    report.violations.some((v) => v.code === 'WAL_BARRIER_ORDER_VIOLATION'),
  );
  const attempt = report.flushes.attempts[0];
  assert.equal(attempt.barrierOrder.ready, false);
});
