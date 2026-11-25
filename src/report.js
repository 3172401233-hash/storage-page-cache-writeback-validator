function line(chunk = '') {
  return chunk;
}

function formatMissing(missing) {
  if (!missing || missing.lsns.length === 0) return '无';
  const suffix = missing.inferred ? '(推断端点)' : '';
  return `[${missing.lsns.join(', ')}]${suffix}`;
}

export function formatReport(report) {
  const out = [];
  out.push(line('=== 页缓存回写 / WAL / Barrier / 崩溃恢复验证报告 ==='));
  if (report.name) out.push(`场景: ${report.name}`);

  out.push('');
  out.push('[1] 回写顺序（按脏页年龄，老页优先）');
  out.push(
    `    最终 WAL 持久化点: LSN ${report.writeback.walPersistedLsn}`,
  );
  for (const page of report.writeback.pages) {
    const flag = page.eligible ? '可回写' : '阻塞  ';
    out.push(
      `    #${page.rank} ${page.pageId} age=${page.age ?? `-dirtyAt:${page.dirtyAt}`} ` +
        `pageLsn=${page.pageLsn} => ${flag}`,
    );
    out.push(
      `        WAL就绪=${page.walReady ? '是' : '否'} ` +
        `barrier就绪=${page.barrierReady ? '是' : '否'} ` +
        `丢失依赖=${formatMissing(page.missingDependencies)}`,
    );
    if (page.blockers.length) {
      out.push(`        阻塞原因: ${page.blockers.join(', ')}`);
    }
  }
  out.push(`    年龄顺序: ${report.writeback.ageOrder.join(' -> ')}`);
  out.push(
    `    实际可回写顺序: ${report.writeback.eligibleOrder.join(' -> ') || '(空)'}`,
  );
  if (report.writeback.deferred.length) {
    out.push(`    推迟页: ${report.writeback.deferred.join(', ')}`);
  }

  if (report.barriers.length) {
    out.push('');
    out.push('[2] 设备 barrier 状态');
    for (const barrier of report.barriers) {
      out.push(
        `    ${barrier.id} targets=[${barrier.targets.join(',')}] ` +
          `状态=${barrier.state} 尝试次数=${barrier.attemptCount}` +
          (barrier.confirmedAt != null ? ` 确认时刻=${barrier.confirmedAt}` : '') +
          (barrier.needsReconfirmation
            ? ` 需要重新确认, 未确认=[${barrier.missingTargets.join(',')}]`
            : ''),
      );
    }
  }

  out.push('');
  out.push('[3] 页刷新竞争');
  if (!report.flushes.attempts.length) {
    out.push('    （未提供 flushAttempts）');
  } else {
    for (const attempt of report.flushes.attempts) {
      out.push(
        `    ${attempt.id} page=${attempt.pageId} ` +
          `区间=[${attempt.startAt},${attempt.endAt}] landed=${attempt.landed} ` +
          `落地时WAL=${attempt.walPersistedLsnAtLanding} ` +
          `顺序${attempt.walOrderOk ? '正确' : '违规'}`,
      );
    }
    if (report.flushes.races.length) {
      for (const race of report.flushes.races) {
        out.push(
          `    竞争: ${race.pageId} ${race.flushIds.join(' <-> ')} ` +
            `区间=${JSON.stringify(race.intervals)}`,
        );
      }
    } else {
      out.push('    未发现重叠刷新竞争');
    }
  }

  out.push('');
  out.push('[4] Checkpoint 安全页');
  if (!report.checkpoints.length) {
    out.push('    （未提供 checkpoints）');
  }
  for (const checkpoint of report.checkpoints) {
    out.push(
      `    ${checkpoint.id} at=${checkpoint.at} walLsn=${checkpoint.walPersistedLsn} ` +
        `必须记录安全页=[${checkpoint.safePages.join(', ')}]`,
    );
    if (checkpoint.claimedPages) {
      out.push(
        `        输入声称记录=[${checkpoint.claimedPages.join(', ')}] ` +
          `不安全记录=[${checkpoint.unsafeClaimedPages.join(', ') || '无'}]`,
      );
    }
  }

  out.push('');
  out.push('[5] 崩溃与恢复范围');
  if (!report.crash) {
    out.push('    （未提供 crash 事件）');
  } else {
    const crash = report.crash;
    out.push(
      `    已确认 WAL=${crash.acknowledgedWalLsn} ` +
        `实际存活尾部=${crash.actualWalTailLsn} ` +
        `尾部丢失=${crash.tailLoss ? '是' : '否'}`,
    );
    if (crash.lostWalInterval) {
      out.push(
        `    丢失 WAL 区间: (${crash.lostWalInterval.afterLsn}, ` +
          `${crash.lostWalInterval.throughLsn}] ` +
          `LSNs=[${crash.lostWalRecords.map((r) => r.lsn).join(', ')}]`,
      );
    }
    for (const page of crash.diskPages) {
      out.push(
        `    ${page.pageId} diskLsn=${page.diskLsn} pageLsn=${page.pageLsn} ` +
          `状态=${page.status} 丢失依赖=[${page.missingLsns.join(', ')}]`,
      );
    }
    const recovery = crash.recovery;
    out.push(`    恢复范围: ${recovery.scope}`);
    out.push(`    redo: LSN ${recovery.redoFromLsn} -> ${recovery.redoToLsn}`);
    out.push(
      `    已恢复事务=[${recovery.recoveredTransactions.join(', ') || '无'}]`,
    );
    out.push(
      `    丢失事务=[${recovery.lostTransactions.join(', ') || '无'}]`,
    );
    out.push(
      `    一致页=[${recovery.consistentPages.join(', ') || '无'}] ` +
        `redo页=[${recovery.redoPages.join(', ') || '无'}] ` +
        `可恢复到尾部=[${recovery.recoverableToTailPages.join(', ') || '无'}]`,
    );
    out.push(
      `    需介质恢复页=[${recovery.unrecoverablePages.join(', ') || '无'}]`,
    );
    for (const step of recovery.recoverySteps) out.push(`      - ${step}`);
  }

  out.push('');
  out.push('[6] 违规与风险');
  if (!report.violations.length) {
    out.push('    无：所有数据页均未先于依赖 WAL 持久化');
  }
  for (const violation of report.violations) {
    out.push(
      `    ${violation.severity.toUpperCase()} ${violation.code}: ${violation.message}`,
    );
  }

  out.push('');
  out.push(
    `结论: ${report.ok ? '通过（无 error 级违规）' : '失败（存在 error 级违规）'} ` +
      `errors=${report.summary.errors} warnings=${report.summary.warnings}`,
  );
  return out.join('\n');
}
