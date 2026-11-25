import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function runCli(args) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
  });
}

test('CLI --json 输出可解析的完整报告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-validator-'));
  const file = join(dir, 'scenario.json');
  writeFileSync(
    file,
    JSON.stringify({
      dirtyPages: [{ id: 'P1', pageLsn: 100, age: 10 }],
      wal: { records: [100], durableLsn: 100 },
    }),
  );

  const stdout = runCli([file, '--json']);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.writeback.ageOrder, ['P1']);
});

test('CLI 文本报告包含每页可回写性与恢复范围标题', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-validator-'));
  const file = join(dir, 'scenario.json');
  writeFileSync(
    file,
    JSON.stringify({
      dirtyPages: [{ id: 'P1', pageLsn: 200, age: 10 }],
      wal: { records: [100, 200], durableLsn: 150 },
      crash: { walTailLsn: 120, landedPages: ['P1'] },
    }),
  );

  const text = runCli([file]);
  assert.match(text, /回写顺序/);
  assert.match(text, /P1/);
  assert.match(text, /ahead-of-wal/);
  assert.match(text, /恢复范围/);
});

test('CLI --strict 在 error 级违规时退出码为 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-validator-'));
  const file = join(dir, 'bad.json');
  writeFileSync(
    file,
    JSON.stringify({
      dirtyPages: [{ id: 'P1', pageLsn: 200 }],
      wal: { durableLsn: 200 },
      crash: { walTailLsn: 100, landedPages: ['P1'] },
    }),
  );

  assert.throws(
    () => runCli([file, '--strict']),
    (error) => error.status === 1,
  );
});
