import {
  ageKey,
  barrierStateAt,
  ensureScenario,
  missingDependencies,
  normalizeScenario,
  walLsnAtTime,
} from './model.js';

function addViolation(list, code, severity, message, detail = {}) {
  list.push({ code, severity, message, ...detail });
}

// 找到在 at 时刻之前已经完全确认、且覆盖 LSN >= pageLsn 的 WAL barrier。
export function walBarrierVerdict(model, page, at) {
  if (!model.options.requireWalBarrier) {
    return { required: false, ready: true, state: 'not-required' };
  }

  let diagnostic = null;
  for (const barrier of model.barriers) {
    if (!barrier.targets.includes(page.device)) continue;
    if (barrier.scope === 'data') continue;

    const state = barrierStateAt(barrier, at);
    const coveredLsn = state.confirmedAt == null ? 0 : walLsnAtTime(model, state.confirmedAt);
    if (!diagnostic) {
      diagnostic = { barrierId: barrier.id, ...state, coveredLsn };
    }
    if (!state.confirmed) continue;
    if (coveredLsn < page.pageLsn) {
      diagnostic = { barrierId: barrier.id, ...state, coveredLsn };
      continue;
    }
    return {
      required: true,
      ready: true,
      state: 'confirmed',
      barrierId: barrier.id,
      confirmedAt: state.confirmedAt,
      coveredLsn,
    };
  }

  if (!diagnostic) {
    return {
      required: true,
      ready: false,
      state: 'missing',
      reasonCode: 'WAL_BARRIER_MISSING',
      barrierId: null,
      needsReconfirmation: false,
      missingTargets: [page.device],
    };
  }

  const reasonCode =
    diagnostic.state === 'confirmed' || diagnostic.state === 'missing'
      ? 'WAL_BARRIER_LSN_BEHIND'
      : 'WAL_BARRIER_UNCONFIRMED';

  return {
    required: true,
    ready: false,
    state: diagnostic.state,
    reasonCode,
    barrierId: diagnostic.barrierId,
    needsReconfirmation: diagnostic.needsReconfirmation === true,
    missingTargets: diagnostic.missingTargets ?? [],
    confirmedAt: diagnostic.confirmedAt ?? null,
    coveredLsn: diagnostic.coveredLsn ?? 0,
  };
}

// checkpoint 前，数据页落地之后是否有已确认的数据 barrier。
function dataBarrierVerdict(model, page, landingAt, checkpointAt) {
  if (!model.options.requireDataBarrier) {
    return { required: false, ready: true, state: 'not-required' };
  }
  if (landingAt == null) {
    return {
      required: true,
      ready: false,
      state: 'not-flushed',
      reasonCode: 'PAGE_NOT_FLUSHED',
    };
  }

  for (const barrier of model.barriers) {
    if (!barrier.targets.includes(page.device)) continue;
    if (barrier.scope === 'wal') continue;
    const state = barrierStateAt(barrier, checkpointAt);
    if (
      state.confirmed &&
      state.confirmedAt >= landingAt &&
      state.confirmedAt <= checkpointAt
    ) {
      return {
        required: true,
        ready: true,
        state: 'confirmed',
        barrierId: barrier.id,
        confirmedAt: state.confirmedAt,
      };
    }
  }

  return {
    required: true,
    ready: false,
    state: 'missing',
    reasonCode: 'DATA_BARRIER_NOT_CONFIRMED',
  };
}

function latestLandingAt(model, pageId, until) {
  const page = model.pages.find((candidate) => candidate.id === pageId);
  let latest = null;
  if (page?.flushedAt != null && page.flushedAt <= until) {
    latest = page.flushedAt;
  }
  for (const flush of model.flushes) {
    if (
      flush.page === pageId &&
      flush.landed &&
      flush.endAt <= until &&
      (latest == null || flush.endAt > latest)
    ) {
      latest = flush.endAt;
    }
  }
  return latest;
}

// 按脏页年龄计算回写顺序，并逐页给出 WAL / barrier 可回写性。
// at 给定时计算该逻辑时刻的计划，否则使用最终已确认 WAL 持久化点。
export function planWriteback(input, at = Infinity) {
  const model = ensureScenario(input);
  const finalView = at === Infinity;
  const walPersistedLsn = finalView
    ? model.wal.durableLsn
    : walLsnAtTime(model, at);

  const orderedPages = [...model.pages].sort(
    (left, right) =>
      ageKey(right) - ageKey(left) || left.index - right.index,
  );

  const pages = orderedPages.map((page, index) => {
    const missing = missingDependencies(
      model,
      walPersistedLsn,
      page.pageLsn,
    );
    const walReady = page.pageLsn <= walPersistedLsn;
    const barrier = walBarrierVerdict(
      model,
      page,
      finalView ? Infinity : at,
    );

    const blockers = [];
    if (!walReady) blockers.push('WAL_NOT_DURABLE');
    if (!barrier.ready) {
      blockers.push(barrier.reasonCode ?? 'WAL_BARRIER_UNCONFIRMED');
    }

    return {
      rank: index + 1,
      pageId: page.id,
      age: page.age,
      dirtyAt: page.dirtyAt,
      device: page.device,
      pageLsn: page.pageLsn,
      eligible: blockers.length === 0,
      walReady,
      barrierReady: barrier.ready,
      blockers,
      missingLsns: missing.lsns,
      missingDependencies: missing,
      barrier,
    };
  });

  return {
    at: finalView ? 'final' : at,
    walPersistedLsn,
    ageOrder: orderedPages.map((page) => page.id),
    writebackOrder: pages.map((page) => ({
      rank: page.rank,
      pageId: page.pageId,
      eligible: page.eligible,
      blockers: page.blockers,
    })),
    eligibleOrder: pages.filter((page) => page.eligible).map((p) => p.pageId),
    deferred: pages.filter((page) => !page.eligible).map((p) => p.pageId),
    pages,
  };
}

function findUnknownReferences(model, violations) {
  const ids = new Set(model.pages.map((page) => page.id));
  for (const flush of model.flushes) {
    if (!ids.has(flush.page)) {
      addViolation(violations, 'UNKNOWN_PAGE_REFERENCE', 'error',
        `刷新事件 ${flush.id} 引用了不存在的页 ${flush.page}`,
        { flushId: flush.id, pageId: flush.page });
    }
  }
  for (const checkpoint of model.checkpoints) {
    for (const pageId of checkpoint.pages ?? []) {
      if (!ids.has(pageId)) {
        addViolation(violations, 'UNKNOWN_PAGE_REFERENCE', 'error',
          `checkpoint ${checkpoint.id} 引用了不存在的页 ${pageId}`,
          { checkpointId: checkpoint.id, pageId });
      }
    }
  }
  if (model.crash) {
    for (const pageId of [
      ...model.crash.landedPages,
      ...model.crash.tornPages,
      ...Object.keys(model.crash.diskPages),
    ]) {
      if (!ids.has(pageId)) {
        addViolation(violations, 'UNKNOWN_PAGE_REFERENCE', 'error',
          `crash 事件引用了不存在的页 ${pageId}`,
          { pageId });
      }
    }
  }
}

function analyzeBarriers(model, violations) {
  return model.barriers.map((barrier) => {
    const state = barrierStateAt(barrier, Infinity);
    if (state.needsReconfirmation) {
      addViolation(
        violations,
        'BARRIER_RECONFIRMATION_PENDING',
        'warning',
        `barrier ${barrier.id} 处于 ${state.state} 状态，必须重新确认 ` +
          `(未确认 target: ${state.missingTargets.join(', ') || '无'})`,
        {
          barrierId: barrier.id,
          state: state.state,
          missingTargets: state.missingTargets,
        },
      );
    }
    return {
      id: barrier.id,
      scope: barrier.scope,
      targets: barrier.targets,
      ...state,
      attempts: barrier.attempts,
    };
  });
}

function intervalsOverlap(left, right) {
  return left.startAt <= right.endAt && right.startAt <= left.endAt;
}

function analyzeFlushes(model, violations) {
  const attempts = model.flushes.map((flush) => {
    const page = model.pages.find((candidate) => candidate.id === flush.page);
    const walLsnAtLanding = walLsnAtTime(model, flush.endAt);
    const missing = page
      ? missingDependencies(model, walLsnAtLanding, page.pageLsn)
      : null;
    const walViolated =
      flush.landed && page != null && page.pageLsn > walLsnAtLanding;

    if (walViolated) {
      addViolation(
        violations,
        'DATA_PERSISTED_BEFORE_WAL',
        'error',
        `页 ${page.id} 的刷新 ${flush.id} 在逻辑时刻 ${flush.endAt} 落地，` +
          `但 WAL 仅持久化到 ${walLsnAtLanding}，依赖 LSN ${page.pageLsn} 尚未持久化`,
        {
          pageId: page.id,
          flushId: flush.id,
          at: flush.endAt,
          walPersistedLsn: walLsnAtLanding,
          requiredLsn: page.pageLsn,
          missingLsns: missing.lsns,
        },
      );
    }

    let barrierVerdict = { required: false, ready: true, state: 'not-required' };
    if (flush.landed && page) {
      barrierVerdict = walBarrierVerdict(model, page, flush.endAt);
      if (!barrierVerdict.ready) {
        addViolation(
          violations,
          'WAL_BARRIER_ORDER_VIOLATION',
          'error',
          `页 ${page.id} 的数据在时刻 ${flush.endAt} 落地，` +
            `但此前没有覆盖 LSN ${page.pageLsn} 的已确认 WAL barrier ` +
            `(${barrierVerdict.reasonCode})`,
          {
            pageId: page.id,
            flushId: flush.id,
            at: flush.endAt,
            reasonCode: barrierVerdict.reasonCode,
            barrierId: barrierVerdict.barrierId,
          },
        );
      }
    }

    return {
      id: flush.id,
      pageId: flush.page,
      startAt: flush.startAt,
      endAt: flush.endAt,
      landed: flush.landed,
      walPersistedLsnAtLanding: walLsnAtLanding,
      walOrderOk: !walViolated,
      barrierOrder: barrierVerdict,
      missingLsns: missing?.lsns ?? [],
    };
  });

  const races = [];
  const byPage = new Map();
  for (const attempt of attempts) {
    const list = byPage.get(attempt.pageId) ?? [];
    list.push(attempt);
    byPage.set(attempt.pageId, list);
  }

  for (const [pageId, list] of byPage) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (!intervalsOverlap(list[i], list[j])) continue;
        const race = {
          pageId,
          flushIds: [list[i].id, list[j].id],
          intervals: [
            [list[i].startAt, list[i].endAt],
            [list[j].startAt, list[j].endAt],
          ],
        };
        races.push(race);
        addViolation(
          violations,
          'FLUSH_RACE',
          'error',
          `页 ${pageId} 存在重叠刷新 ${list[i].id} 与 ${list[j].id}，` +
            '页刷新竞争可能让旧检查/旧请求绕过 WAL 顺序',
          race,
        );
      }
    }
  }

  return { attempts, races };
}

function analyzeCheckpoints(model, violations) {
  return model.checkpoints.map((checkpoint) => {
    const walLsn = walLsnAtTime(model, checkpoint.at);
    const safePages = [];
    const unsafePages = [];

    for (const page of model.pages) {
      const reasons = [];
      const landingAt = latestLandingAt(model, page.id, checkpoint.at);
      if (landingAt == null) reasons.push('PAGE_NOT_FLUSHED');

      if (page.pageLsn > walLsn) reasons.push('WAL_NOT_DURABLE_AT_CHECKPOINT');

      const walBarrier = walBarrierVerdict(model, page, checkpoint.at);
      if (!walBarrier.ready) {
        reasons.push(walBarrier.reasonCode ?? 'WAL_BARRIER_NOT_CONFIRMED');
      }

      const dataBarrier = dataBarrierVerdict(
        model,
        page,
        landingAt,
        checkpoint.at,
      );
      if (!dataBarrier.ready && dataBarrier.reasonCode) {
        reasons.push(dataBarrier.reasonCode);
      }

      if (reasons.length === 0) {
        safePages.push(page.id);
      } else {
        unsafePages.push({ pageId: page.id, reasons });
      }
    }

    const claimedPages = checkpoint.pages;
    const claimedSet = new Set(claimedPages ?? []);
    const unsafeClaimed = (claimedPages ?? []).filter((pageId) =>
      unsafePages.some((entry) => entry.pageId === pageId),
    );
    const omittedSafePages = claimedPages
      ? safePages.filter((pageId) => !claimedSet.has(pageId))
      : [];

    for (const pageId of unsafeClaimed) {
      const entry = unsafePages.find((item) => item.pageId === pageId);
      addViolation(
        violations,
        'CHECKPOINT_RECORDS_UNSAFE_PAGE',
        'error',
        `checkpoint ${checkpoint.id} 记录了不安全页 ${pageId}: ` +
          `${entry?.reasons.join(', ') ?? 'UNKNOWN'}`,
        {
          checkpointId: checkpoint.id,
          pageId,
          reasons: entry?.reasons ?? [],
        },
      );
    }

    if (omittedSafePages.length) {
      addViolation(
        violations,
        'CHECKPOINT_SAFE_PAGES_OMITTED',
        'warning',
        `checkpoint ${checkpoint.id} 漏记了安全页: ${omittedSafePages.join(', ')}`,
        { checkpointId: checkpoint.id, pageIds: omittedSafePages },
      );
    }

    return {
      id: checkpoint.id,
      at: checkpoint.at,
      walPersistedLsn: walLsn,
      redoStartLsn: checkpoint.redoStartLsn,
      // 引擎计算出的、checkpoint 必须记录的安全页集合。
      safePages,
      unsafePages,
      claimedPages,
      unsafeClaimedPages: unsafeClaimed,
      omittedSafePages,
      record: {
        checkpointId: checkpoint.id,
        at: checkpoint.at,
        safePages,
      },
    };
  });
}

function resolveDiskLsn(model, page) {
  const crash = model.crash;
  const explicit = crash.diskPages?.[page.id];
  if (explicit && typeof explicit === 'object') {
    return {
      diskLsn: explicit.diskLsn == null ? page.pageLsn : Number(explicit.diskLsn),
      torn: explicit.torn === true,
      source: 'crash.diskPages',
    };
  }
  if (crash.tornPages.includes(page.id)) {
    return { diskLsn: page.pageLsn, torn: true, source: 'crash.tornPages' };
  }
  if (crash.landedPages.includes(page.id)) {
    return { diskLsn: page.pageLsn, torn: false, source: 'crash.landedPages' };
  }
  return {
    diskLsn: page.diskLsn ?? 0,
    torn: false,
    source: page.diskLsn == null ? 'default-empty-image' : 'page.diskLsn',
  };
}

function analyzeCrash(model, violations) {
  const crash = model.crash;
  if (!crash) return null;

  const acknowledgedLsn = crash.acknowledgedLsn ?? model.wal.durableLsn;
  const tailLsn = crash.walTailLsn;
  const tailLoss = tailLsn < acknowledgedLsn;

  const lostWal = missingDependencies(model, tailLsn, acknowledgedLsn);
  if (tailLoss) {
    addViolation(
      violations,
      'WAL_TAIL_LOSS',
      'warning',
      `崩溃后 WAL 实际只存活到 ${tailLsn}，已确认到 ${acknowledgedLsn}，` +
        `丢失尾部区间 (${tailLsn}, ${acknowledgedLsn}]`,
      {
        actualWalTailLsn: tailLsn,
        acknowledgedWalLsn: acknowledgedLsn,
        lostLsns: lostWal.lsns,
      },
    );
  }

  const commits = model.records.filter(
    (record) => record.type === 'commit' || record.commit === true,
  );
  const recoveredTransactions = commits
    .filter((record) => record.lsn <= tailLsn)
    .map((record) => record.tx ?? record.txId ?? `lsn:${record.lsn}`);
  const lostTransactions = commits
    .filter((record) => record.lsn > tailLsn && record.lsn <= acknowledgedLsn)
    .map((record) => record.tx ?? record.txId ?? `lsn:${record.lsn}`);

  if (lostTransactions.length) {
    addViolation(
      violations,
      'COMMITTED_TX_IN_LOST_TAIL',
      'warning',
      `已确认提交的事务随 WAL 尾部丢失: ${lostTransactions.join(', ')}`,
      { transactionIds: lostTransactions },
    );
  }

  const diskPages = model.pages.map((page) => {
    const disk = resolveDiskLsn(model, page);
    const diskMissing = missingDependencies(model, tailLsn, disk.diskLsn);
    const intendedMissing = missingDependencies(
      model,
      tailLsn,
      page.pageLsn,
    );

    let status;
    if (disk.torn) status = 'torn';
    else if (disk.diskLsn > tailLsn) status = 'ahead-of-wal';
    else if (page.pageLsn <= tailLsn && disk.diskLsn >= page.pageLsn)
      status = 'consistent';
    else if (page.pageLsn <= tailLsn) status = 'redo-pending';
    else status = 'recoverable-to-tail';

    if (status === 'torn') {
      addViolation(
        violations,
        'PAGE_TORN',
        'error',
        `页 ${page.id} 崩溃时发生撕裂写，旧镜像/备份恢复前不能做 WAL redo`,
        { pageId: page.id },
      );
    }
    if (status === 'ahead-of-wal') {
      addViolation(
        violations,
        'DATA_PAGE_AHEAD_OF_WAL',
        'error',
        `页 ${page.id} 的磁盘镜像 LSN=${disk.diskLsn} 新于 WAL 尾部 ${tailLsn}，` +
          `数据页先于依赖 WAL 持久化，丢失依赖: ${diskMissing.lsns.join(', ') || '未知区间'}`,
        {
          pageId: page.id,
          diskLsn: disk.diskLsn,
          walTailLsn: tailLsn,
          missingLsns: diskMissing.lsns,
        },
      );
    }

    return {
      pageId: page.id,
      pageLsn: page.pageLsn,
      diskLsn: disk.diskLsn,
      diskStateSource: disk.source,
      torn: disk.torn,
      status,
      // 磁盘上这一版镜像真正依赖、但 WAL 尾部缺失的记录。
      missingDependencies: diskMissing,
      missingLsns: diskMissing.lsns,
      // 脏页最新意图相对 WAL 尾部丢失的变更。
      lostIntendedChanges:
        page.pageLsn > tailLsn ? intendedMissing : { lsns: [] },
      redoRequired: status === 'redo-pending',
    };
  });

  const byStatus = (status) =>
    diskPages.filter((page) => page.status === status).map((p) => p.pageId);
  const aheadOfWalPages = byStatus('ahead-of-wal');
  const tornPages = byStatus('torn');
  const unrecoverablePages = [...aheadOfWalPages, ...tornPages];

  const lastCheckpoint =
    model.checkpoints[model.checkpoints.length - 1] ?? null;
  const minimumDiskLsn = diskPages.reduce(
    (min, page) => Math.min(min, page.diskLsn),
    Infinity,
  );
  const redoFromLsn =
    crash.redoFromLsn ??
    lastCheckpoint?.redoStartLsn ??
    (Number.isFinite(minimumDiskLsn) ? minimumDiskLsn : 0);

  const recovery = {
    recoverable: unrecoverablePages.length === 0,
    scope:
      unrecoverablePages.length === 0
        ? 'wal-redo-to-tail'
        : 'media-recovery-required',
    checkpointId: lastCheckpoint?.id ?? null,
    redoFromLsn,
    redoToLsn: tailLsn,
    recoveredTransactions,
    lostTransactions,
    consistentPages: byStatus('consistent'),
    redoPages: byStatus('redo-pending'),
    recoverableToTailPages: byStatus('recoverable-to-tail'),
    aheadOfWalPages,
    tornPages,
    unrecoverablePages,
    recoverySteps:
      unrecoverablePages.length === 0
        ? [
            `从 checkpoint ${lastCheckpoint?.id ?? '(无)'} 与 LSN ${redoFromLsn} 开始 WAL redo`,
            `重放至实际 WAL 尾部 LSN ${tailLsn}`,
            '对 redo-pending 页补齐缺失的页变更',
          ]
        : [
            `WAL 只能自动恢复到 LSN ${tailLsn}`,
            `以下页超出 WAL 或已撕裂，必须先从本地 checkpoint 镜像/基线备份恢复: ${unrecoverablePages.join(', ')}`,
            '恢复镜像后再重放仍存活的 WAL 前缀',
          ],
  };

  return {
    at: crash.at,
    acknowledgedWalLsn: acknowledgedLsn,
    actualWalTailLsn: tailLsn,
    tailLoss,
    lostWalInterval: tailLoss
      ? { afterLsn: tailLsn, throughLsn: acknowledgedLsn }
      : null,
    lostWalRecords: lostWal.records,
    committedTransactionsRecovered: recoveredTransactions,
    committedTransactionsLost: lostTransactions,
    diskPages,
    recovery,
  };
}

export function analyzeScenario(input) {
  const model = normalizeScenario(input);
  const violations = [];

  findUnknownReferences(model, violations);
  const writeback = planWriteback(model);
  const barriers = analyzeBarriers(model, violations);
  const flushes = analyzeFlushes(model, violations);
  const checkpoints = analyzeCheckpoints(model, violations);
  const crash = analyzeCrash(model, violations);

  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.length - errors;

  return {
    ok: errors === 0,
    name: model.name,
    writeback,
    barriers,
    flushes,
    checkpoints,
    crash,
    recovery: crash?.recovery ?? null,
    violations,
    summary: {
      errors,
      warnings,
      pages: model.pages.length,
      barriers: model.barriers.length,
      checkpoints: model.checkpoints.length,
      flushAttempts: model.flushes.length,
    },
  };
}
