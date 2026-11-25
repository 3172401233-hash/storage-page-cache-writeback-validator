import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScenario } from '../src/index.js';

test('同页重叠刷新被识别为页刷新竞争', () => {
  const report = analyzeScenario({
    name: 'overlapping-flush-race',
    dirtyPages: [{ id: 'P1', pageLsn: 200, age: 30 }],
    wal: {
      records: [100, 200],
      initialDurableLsn: 0,
      durableLsn: 200,
    },
    walPersistencePoints: [
      { lsn: 100, at: 1 },
      { lsn: 200, at: 5 },
    ],
    flushAttempts: [
      // F1 在 WAL 推进到 200 之前就落地。
      { id: 'F1', page: 'P1', startAt: 2, endAt: 4 },
      // F2 与 F1 重叠，构成竞争。
      { id: 'F2', page: 'P1', startAt: 3, endAt: 6 },
    ],
  });

  assert.equal(report.flushes.races.length, 1);
  assert.deepEqual(report.flushes.races[0].flushIds, ['F1', 'F2']);
  assert.ok(report.violations.some((v) => v.code === 'FLUSH_RACE'));
  assert.equal(report.ok, false);
});

test('竞争中提前落地的刷新同时违反 DATA_PERSISTED_BEFORE_WAL', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 200, age: 30 }],
    wal: {
      records: [100, 200],
      initialDurableLsn: 0,
      durableLsn: 200,
    },
    walPersistencePoints: [
      { lsn: 100, at: 1 },
      { lsn: 200, at: 5 },
    ],
    flushAttempts: [
      { id: 'F1', page: 'P1', startAt: 2, endAt: 4 },
      { id: 'F2', page: 'P1', startAt: 3, endAt: 6 },
    ],
  });

  const early = report.flushes.attempts.find((a) => a.id === 'F1');
  const safe = report.flushes.attempts.find((a) => a.id === 'F2');
  assert.equal(early.walOrderOk, false);
  assert.deepEqual(early.missingLsns, [200]);
  assert.equal(safe.walOrderOk, true);

  const walViolation = report.violations.find(
    (v) => v.code === 'DATA_PERSISTED_BEFORE_WAL',
  );
  assert.ok(walViolation);
  assert.equal(walViolation.flushId, 'F1');
  assert.deepEqual(walViolation.missingLsns, [200]);
});

test('同页刷新严格串行时不误报竞争，WAL 顺序正确时通过', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 100, age: 30 }],
    wal: { records: [100], durableLsn: 100 },
    walPersistencePoints: [{ lsn: 100, at: 1 }],
    flushAttempts: [
      { id: 'F1', page: 'P1', startAt: 1, endAt: 2 },
      { id: 'F2', page: 'P1', startAt: 3, endAt: 4 },
    ],
  });

  assert.deepEqual(report.flushes.races, []);
  assert.equal(report.violations.some((v) => v.code === 'FLUSH_RACE'), false);
  assert.equal(report.ok, true);
});

test('landed=false 的失败刷新不判定为数据先于 WAL 持久化', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 200, age: 30 }],
    wal: { records: [200], initialDurableLsn: 0, durableLsn: 200 },
    walPersistencePoints: [{ lsn: 200, at: 5 }],
    flushAttempts: [
      { id: 'F-failed', page: 'P1', startAt: 1, endAt: 2, landed: false },
    ],
  });

  assert.equal(
    report.violations.some((v) => v.code === 'DATA_PERSISTED_BEFORE_WAL'),
    false,
  );
});
