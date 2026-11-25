// 本地存储模型：所有“设备 / 页缓存 / WAL / barrier / checkpoint / 崩溃”
// 都只是进程内的纯数据结构，不连接任何数据库、磁盘服务或外部存储。

export const DEFAULT_DEVICE = 'dev0';

export function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  return value;
}

// 年龄排序键：值越大表示脏得越久（越老）。
// 优先使用显式 age；否则用 dirtyAt（时间越小越老，因此取负）。
export function ageKey(page) {
  if (page.age != null && Number.isFinite(page.age)) return page.age;
  if (page.dirtyAt != null && Number.isFinite(page.dirtyAt)) return -page.dirtyAt;
  return 0;
}

export function normalizeScenario(input = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('场景输入必须是 JSON 对象');
  }

  const rawPages = input.dirtyPages ?? input.pages ?? [];
  if (!Array.isArray(rawPages)) throw new Error('dirtyPages 必须是数组');

  const seenIds = new Set();
  const pages = rawPages.map((rawPage, index) => {
    if (typeof rawPage !== 'object' || rawPage === null) {
      throw new Error(`dirtyPages[${index}] 必须是对象`);
    }
    const id = String(rawPage.id ?? rawPage.pageId ?? `P${index + 1}`);
    if (seenIds.has(id)) throw new Error(`重复的页 ID: ${id}`);
    seenIds.add(id);
    return {
      id,
      index,
      pageLsn: asNumber(rawPage.pageLsn ?? rawPage.lsn, 0),
      age: rawPage.age == null ? null : asNumber(rawPage.age),
      dirtyAt: rawPage.dirtyAt == null ? null : asNumber(rawPage.dirtyAt),
      device: rawPage.device == null ? DEFAULT_DEVICE : String(rawPage.device),
      diskLsn: rawPage.diskLsn == null ? null : asNumber(rawPage.diskLsn),
      flushedAt: rawPage.flushedAt == null ? null : asNumber(rawPage.flushedAt),
    };
  });

  const walInput = input.wal ?? {};
  const rawRecords = walInput.records ?? walInput.lsns ?? [];
  const records = toArray(rawRecords, 'wal.records')
    .map((record) =>
      typeof record === 'number'
        ? { lsn: record }
        : { ...record, lsn: asNumber(record.lsn) },
    )
    .sort((a, b) => a.lsn - b.lsn);

  const initialDurableLsn = asNumber(
    walInput.initialDurableLsn ?? walInput.baseLsn,
    0,
  );

  const rawPoints =
    input.walPersistencePoints ??
    walInput.persistencePoints ??
    walInput.points ??
    [];
  const walPoints = toArray(rawPoints, 'walPersistencePoints').map(
    (point, index) => ({
      lsn: asNumber(point.lsn ?? point.durableLsn),
      at: asNumber(point.at ?? point.time ?? index),
    }),
  );

  const maxPointLsn = walPoints.reduce((max, p) => Math.max(max, p.lsn), 0);
  const durableLsn = asNumber(
    walInput.durableLsn ?? walInput.persistedLsn ?? maxPointLsn,
    Math.max(initialDurableLsn, maxPointLsn),
  );

  const barriers = toArray(input.barriers, 'barriers').map(
    (barrier, index) => {
      const id = String(barrier.id ?? `B${index + 1}`);
      const targets = toArray(
        barrier.targets ?? barrier.devices ?? [DEFAULT_DEVICE],
        `barriers[${index}].targets`,
      ).map(String);
      const failed = barrier.failed === true || barrier.result === 'failed';
      const initialAcks = Array.isArray(barrier.acks)
        ? barrier.acks.map(String)
        : failed
          ? []
          : [...targets];
      const baseAt = asNumber(barrier.at ?? barrier.time, 0);
      const reconfirmations = toArray(
        barrier.reconfirm ?? barrier.reconfirmations ?? barrier.retries,
        `barriers[${index}].reconfirm`,
      );
      const attempts = [
        { attempt: 0, at: baseAt, acks: initialAcks },
        ...reconfirmations.map((item, retryIndex) => ({
          attempt: retryIndex + 1,
          at: asNumber(item.at ?? item.time, baseAt + retryIndex + 1),
          acks: Array.isArray(item.acks) ? item.acks.map(String) : [],
        })),
      ].sort((a, b) => a.at - b.at || a.attempt - b.attempt);

      return {
        id,
        index,
        scope: barrier.scope ?? null,
        targets,
        attempts,
      };
    },
  );

  const checkpoints = toArray(input.checkpoints, 'checkpoints').map(
    (checkpoint, index) => ({
      id: String(checkpoint.id ?? `CP${index + 1}`),
      index,
      at: asNumber(checkpoint.at ?? checkpoint.time ?? index),
      pages: Array.isArray(checkpoint.pages)
        ? checkpoint.pages.map(String)
        : Array.isArray(checkpoint.safePages)
          ? checkpoint.safePages.map(String)
          : null,
      redoStartLsn:
        checkpoint.redoStartLsn == null
          ? null
          : asNumber(checkpoint.redoStartLsn),
    }),
  );

  const flushes = toArray(
    input.flushAttempts ?? input.flushes ?? input.pageFlushes,
    'flushAttempts',
  ).map((flush, index) => {
    const endAt = asNumber(
      flush.endAt ?? flush.end ?? flush.at ?? flush.time,
      0,
    );
    const startAt = asNumber(
      flush.startAt ?? flush.start ?? flush.issuedAt ?? flush.at,
      endAt,
    );
    return {
      id: String(flush.id ?? `F${index + 1}`),
      page: String(flush.page ?? flush.pageId),
      startAt: Math.min(startAt, endAt),
      endAt: Math.max(startAt, endAt),
      landed: flush.landed !== false && flush.result !== 'failed',
    };
  });

  let crash = null;
  const rawCrash = input.crash ?? input.crashEvent ?? null;
  if (rawCrash) {
    const tailLsnRaw = rawCrash.walTailLsn ?? rawCrash.tailLsn ?? null;
    const ackLsnRaw =
      rawCrash.acknowledgedLsn ?? rawCrash.durableLsn ?? null;
    crash = {
      at: rawCrash.at == null ? null : asNumber(rawCrash.at),
      walTailLsn: tailLsnRaw == null ? null : asNumber(tailLsnRaw),
      acknowledgedLsn: ackLsnRaw == null ? null : asNumber(ackLsnRaw),
      landedPages: toArray(
        rawCrash.landedPages ?? rawCrash.pages ?? [],
        'crash.landedPages',
      ).map(String),
      tornPages: toArray(rawCrash.tornPages ?? [], 'crash.tornPages').map(
        String,
      ),
      diskPages: rawCrash.diskPages ?? rawCrash.diskState ?? {},
      redoFromLsn:
        rawCrash.redoFromLsn == null ? null : asNumber(rawCrash.redoFromLsn),
    };
    if (crash.walTailLsn == null) {
      throw new Error('crash 事件必须给出 walTailLsn（崩溃后实际存活的 WAL 尾部）');
    }
  }

  const barrierModel = barriers.length > 0;
  const options = {
    requireWalBarrier:
      input.options?.requireWalBarrier == null
        ? barrierModel
        : input.options.requireWalBarrier !== false,
    requireDataBarrier:
      input.options?.requireDataBarrier == null
        ? barrierModel
        : input.options.requireDataBarrier !== false,
  };

  return {
    normalized: true,
    name: input.name ?? null,
    pages,
    records,
    wal: { initialDurableLsn, durableLsn },
    walPoints,
    barriers,
    checkpoints,
    flushes,
    crash,
    options,
  };
}

export function ensureScenario(input) {
  return input && input.normalized === true ? input : normalizeScenario(input);
}

// 逻辑时刻 at 时，日志层已确认的 WAL 持久化点。
export function walLsnAtTime(model, at) {
  if (!model.walPoints.length) return model.wal.durableLsn;
  let lsn = model.wal.initialDurableLsn;
  for (const point of model.walPoints) {
    if (point.at <= at) lsn = Math.max(lsn, point.lsn);
  }
  return lsn;
}

// 计算某个 barrier 在逻辑时刻 at 的确认状态。
// confirmed：已有一次尝试被全部 target 确认；
// partial/failed：最近一次尝试未覆盖全部 target，必须重新确认。
export function barrierStateAt(barrier, at) {
  const attempts = barrier.attempts.filter((attempt) => attempt.at <= at);
  if (!attempts.length) {
    return {
      state: 'missing',
      confirmed: false,
      confirmedAt: null,
      needsReconfirmation: false,
      missingTargets: [...barrier.targets],
      latestAttempt: null,
      attemptCount: 0,
    };
  }

  let confirmedAt = null;
  for (const attempt of attempts) {
    const acks = new Set(attempt.acks);
    if (barrier.targets.every((target) => acks.has(target))) {
      confirmedAt = attempt.at;
      break;
    }
  }

  const latest = attempts[attempts.length - 1];
  const acks = new Set(latest.acks);
  const missingTargets = barrier.targets.filter(
    (target) => !acks.has(target),
  );

  let state;
  if (confirmedAt != null) state = 'confirmed';
  else if (latest.acks.length === 0) state = 'failed';
  else state = 'partial';

  return {
    state,
    confirmed: state === 'confirmed',
    confirmedAt,
    needsReconfirmation: state !== 'confirmed',
    missingTargets,
    latestAttempt: latest.attempt,
    attemptCount: attempts.length,
  };
}

// 页面对 WAL 的依赖：所有 lsn 落在 (availableLsn, requiredLsn] 的记录。
// 没有给出 wal.records 时，至少指出 requiredLsn 这条端点依赖（inferred）。
export function missingDependencies(model, availableLsn, requiredLsn) {
  const available = asNumber(availableLsn);
  const required = asNumber(requiredLsn);
  const base = {
    availableThroughLsn: available,
    requiredThroughLsn: required,
    lsns: [],
    records: [],
    inferred: false,
  };
  if (required <= available) return base;

  const known = model.records.filter(
    (record) => record.lsn > available && record.lsn <= required,
  );
  if (known.length) {
    return {
      ...base,
      lsns: known.map((record) => record.lsn),
      records: known.map((record) => ({ ...record })),
    };
  }
  return {
    ...base,
    inferred: true,
    lsns: [required],
    records: [{ lsn: required, inferred: true }],
  };
}
