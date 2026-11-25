import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScenario } from '../src/index.js';

const tailLossFixture = {
  name: 'wal-tail-missing-after-crash',
  dirtyPages: [
    { id: 'PA', pageLsn: 200, age: 100 },
    { id: 'PB', pageLsn: 180, age: 50 },
    { id: 'PC', pageLsn: 120, age: 10, diskLsn: 100 },
  ],
  wal: {
    records: [
      { lsn: 100, tx: 'T1', type: 'begin' },
      { lsn: 120, tx: 'T1', type: 'commit' },
      { lsn: 150, tx: 'T2', type: 'begin' },
      { lsn: 180, tx: 'T2', type: 'commit' },
      { lsn: 200, tx: 'T3', type: 'commit' },
    ],
    durableLsn: 200,
  },
  barriers: [
    { id: 'B0', at: 0, targets: ['dev0'], acks: ['dev0'] },
  ],
  crash: {
    at: 9,
    walTailLsn: 140,
    diskPages: {
      PA: { diskLsn: 200 },
      PB: { diskLsn: 180 },
    },
  },
};

test('尾部丢失：确认点 200 但实际 WAL 只存活到 140', () => {
  const report = analyzeScenario(tailLossFixture);
  const crash = report.crash;
  assert.equal(crash.acknowledgedWalLsn, 200);
  assert.equal(crash.actualWalTailLsn, 140);
  assert.equal(crash.tailLoss, true);
  assert.deepEqual(crash.lostWalInterval, {
    afterLsn: 140,
    throughLsn: 200,
  });
  assert.deepEqual(
    crash.lostWalRecords.map((r) => r.lsn),
    [150, 180, 200],
  );
  assert.ok(report.violations.some((v) => v.code === 'WAL_TAIL_LOSS'));
});

test('恢复范围：已提交事务按 WAL 尾部划分恢复/丢失', () => {
  const recovery = analyzeScenario(tailLossFixture).recovery;
  assert.deepEqual(recovery.recoveredTransactions, ['T1']);
  assert.deepEqual(recovery.lostTransactions, ['T2', 'T3']);
});

test('先于 WAL 写入的数据页被标记 ahead-of-wal 并列出丢失依赖', () => {
  const report = analyzeScenario(tailLossFixture);
  const byId = Object.fromEntries(
    report.crash.diskPages.map((p) => [p.pageId, p]),
  );

  assert.equal(byId.PA.status, 'ahead-of-wal');
  assert.deepEqual(byId.PA.missingLsns, [150, 180, 200]);

  assert.equal(byId.PB.status, 'ahead-of-wal');
  assert.deepEqual(byId.PB.missingLsns, [150, 180]);

  assert.equal(byId.PC.status, 'redo-pending');
  assert.deepEqual(byId.PC.missingLsns, []);
  assert.equal(byId.PC.redoRequired, true);

  const aheadViolations = report.violations.filter(
    (v) => v.code === 'DATA_PAGE_AHEAD_OF_WAL',
  );
  assert.equal(aheadViolations.length, 2);
});

test('存在 ahead-of-wal 页时恢复范围收敛为介质恢复', () => {
  const recovery = analyzeScenario(tailLossFixture).recovery;
  assert.equal(recovery.recoverable, false);
  assert.equal(recovery.scope, 'media-recovery-required');
  assert.deepEqual(recovery.aheadOfWalPages, ['PA', 'PB']);
  assert.deepEqual(recovery.unrecoverablePages, ['PA', 'PB']);
  assert.deepEqual(recovery.redoPages, ['PC']);
  assert.equal(recovery.redoToLsn, 140);
  assert.ok(recovery.recoverySteps.length >= 2);
});

test('landedPages 简写等价于 diskLsn=pageLsn', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 100 }],
    wal: { records: [100], durableLsn: 100 },
    crash: { walTailLsn: 90, landedPages: ['P1'] },
  });
  const page = report.crash.diskPages[0];
  assert.equal(page.diskLsn, 100);
  assert.equal(page.diskStateSource, 'crash.landedPages');
  assert.equal(page.status, 'ahead-of-wal');
  assert.deepEqual(page.missingLsns, [100]);
});

test('没有 ahead/torn 页时范围是 WAL redo 到尾部，即使存在数据丢失窗口', () => {
  const report = analyzeScenario({
    dirtyPages: [
      { id: 'P1', pageLsn: 120 },
      { id: 'P2', pageLsn: 200 },
    ],
    wal: { records: [100, 120, 200], durableLsn: 200 },
    crash: {
      walTailLsn: 150,
      diskPages: { P1: { diskLsn: 100 } },
      // P2 没有落地，磁盘保留 LSN=0 的旧镜像。
    },
  });
  const recovery = report.recovery;
  assert.equal(recovery.recoverable, true);
  assert.equal(recovery.scope, 'wal-redo-to-tail');
  assert.deepEqual(recovery.redoPages, ['P1']);
  assert.deepEqual(recovery.recoverableToTailPages, ['P2']);
  assert.deepEqual(recovery.unrecoverablePages, []);
});

test('撕裂页必须先介质恢复', () => {
  const report = analyzeScenario({
    dirtyPages: [{ id: 'P1', pageLsn: 100 }],
    wal: { records: [100], durableLsn: 100 },
    crash: { walTailLsn: 100, tornPages: ['P1'] },
  });
  assert.equal(report.crash.diskPages[0].status, 'torn');
  assert.ok(report.violations.some((v) => v.code === 'PAGE_TORN'));
  assert.equal(report.recovery.scope, 'media-recovery-required');
  assert.deepEqual(report.recovery.tornPages, ['P1']);
});
