import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScenario, planWriteback } from '../src/index.js';

const fixture = {
  name: 'age-order-and-wal-gate',
  dirtyPages: [
    { id: 'P-young', pageLsn: 90, age: 5 },
    { id: 'P-old', pageLsn: 200, age: 120 },
    { id: 'P-mid', pageLsn: 150, age: 60 },
  ],
  wal: { records: [90, 120, 150, 180, 200], durableLsn: 150 },
};

test('回写顺序严格按脏页年龄：最老的页排第一', () => {
  const plan = planWriteback(fixture);
  assert.deepEqual(plan.ageOrder, ['P-old', 'P-mid', 'P-young']);
  assert.deepEqual(
    plan.pages.map((p) => p.rank),
    [1, 2, 3],
  );
});

test('pageLsn 超过 WAL 持久化点的页不可回写，并给出丢失依赖', () => {
  const plan = planWriteback(fixture);
  const oldPage = plan.pages.find((p) => p.pageId === 'P-old');
  assert.equal(oldPage.eligible, false);
  assert.equal(oldPage.walReady, false);
  assert.ok(oldPage.blockers.includes('WAL_NOT_DURABLE'));
  assert.deepEqual(oldPage.missingLsns, [180, 200]);
  assert.equal(
    oldPage.missingDependencies.availableThroughLsn,
    150,
  );
  assert.equal(oldPage.missingDependencies.requiredThroughLsn, 200);

  const midPage = plan.pages.find((p) => p.pageId === 'P-mid');
  assert.equal(midPage.eligible, true);
  assert.deepEqual(midPage.missingLsns, []);

  assert.deepEqual(plan.eligibleOrder, ['P-mid', 'P-young']);
  assert.deepEqual(plan.deferred, ['P-old']);
});

test('WAL 持久化点推进到 pageLsn 后，老页恢复可回写且顺序不变', () => {
  const advanced = {
    ...fixture,
    wal: { ...fixture.wal, durableLsn: 200 },
  };
  const plan = planWriteback(advanced);
  assert.deepEqual(plan.eligibleOrder, ['P-old', 'P-mid', 'P-young']);
  assert.deepEqual(plan.deferred, []);
});

test('没有 age 时使用 dirtyAt：dirtyAt 越小（越早变脏）越优先', () => {
  const plan = planWriteback({
    dirtyPages: [
      { id: 'P-later', pageLsn: 1, dirtyAt: 10 },
      { id: 'P-earlier', pageLsn: 1, dirtyAt: 1 },
      { id: 'P-middle', pageLsn: 1, dirtyAt: 5 },
    ],
    wal: { durableLsn: 10 },
  });
  assert.deepEqual(plan.ageOrder, ['P-earlier', 'P-middle', 'P-later']);
});

test('纯回写计划场景不产生 error 级违规', () => {
  const report = analyzeScenario(fixture);
  assert.equal(report.ok, true);
  assert.equal(report.summary.errors, 0);
});
