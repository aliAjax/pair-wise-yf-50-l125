import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export type OperationStatus = "待同步" | "已确认" | "同步失败";

/** 每次本地改动都会生成一条带编号的操作，编号是幂等键：同一编号重复提交只应用一次 */
export interface SyncOperation {
  seq: number;
  entity: string;
  action: string;
  detail: string;
  time: string;
  status: OperationStatus;
  batchId: string | null;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
}

export interface MetricsSnapshot {
  households: number;
  urgent: number;
  openTasks: number;
  queued: number;
}

export interface SyncLogEntry {
  id: string;
  time: string;
  kind: "批次合并" | "冲突处理" | "同步失败" | "容量整理" | "数据升级";
  detail: string;
  metrics?: MetricsSnapshot;
}

const KEY = "pair-wise-yf-50/assessment";
const SCHEMA_VERSION = 2;
const OPERATION_CAPACITY = 120;
const NEAR_CAPACITY = 96;
const BATCH_SIZE = 20;
const KEEP_CONFIRMED = 20;

/** 参与三方合并的字段（version / deviceUpdatedAt 由合并逻辑自行维护） */
const MERGE_FIELDS: (keyof Household)[] = ["head", "community", "address", "members", "vulnerable", "needLevel", "needs", "status", "note"];

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];
/** 上次同步时的基线快照：h1 地址仍是旧写法，本地后来改过，用于演示三方合并 */
const seedSnapshots: Record<string, Household> = Object.fromEntries(
  seedHouseholds.map((item) => {
    const snapshot = JSON.parse(JSON.stringify(item)) as Household;
    if (item.id === "h1") snapshot.address = "河湾路18号";
    return [item.id, snapshot];
  })
);

interface PersistedState {
  schemaVersion: number;
  households: Household[];
  tasks: FieldTask[];
  operations: SyncOperation[];
  appliedSeqs: number[];
  nextSeq: number;
  syncedSnapshots: Record<string, Household>;
  conflicts: FieldConflict[];
  lastSyncedAt: string;
  syncLog: SyncLogEntry[];
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function chunk<T>(list: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
  return result;
}

/** 旧版本（v1：queue 为无编号 PendingChange）升级，家庭记录与冲突原样保留 */
function migrateLegacy(old: Record<string, unknown>): PersistedState {
  const legacyQueue = (Array.isArray(old.queue) ? old.queue : []) as { entity: string; action: string; detail: string; time: string }[];
  const households = (old.households ?? []) as Household[];
  const conflicts = (old.conflicts ?? []) as FieldConflict[];
  const operations: SyncOperation[] = legacyQueue.map((item, index) => ({
    seq: index + 1,
    entity: item.entity,
    action: item.action,
    detail: item.detail,
    time: item.time,
    status: "待同步",
    batchId: null
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    households,
    tasks: (old.tasks ?? []) as FieldTask[],
    operations,
    appliedSeqs: [],
    nextSeq: operations.length + 1,
    syncedSnapshots: Object.fromEntries(households.map((item) => [item.id, deepCopy(item)])),
    conflicts,
    lastSyncedAt: (old.lastSyncedAt as string) ?? new Date().toISOString(),
    syncLog: [{ id: crypto.randomUUID(), time: new Date().toISOString(), kind: "数据升级", detail: `旧版本数据已升级：保留 ${households.length} 条家庭记录、${operations.length} 条待同步变更与 ${conflicts.length} 条冲突，可正常打开` }]
  };
}

function loadPersisted(): PersistedState | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.schemaVersion === SCHEMA_VERSION) return parsed as unknown as PersistedState;
    return migrateLegacy(parsed);
  } catch {
    return null;
  }
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = loadPersisted();
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const operations = ref<SyncOperation[]>(initial?.operations ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const appliedSeqs = ref<number[]>(initial?.appliedSeqs ?? []);
  const nextSeq = ref(initial?.nextSeq ?? 1);
  const syncedSnapshots = ref<Record<string, Household>>(initial?.syncedSnapshots ?? seedSnapshots);
  const syncLog = ref<SyncLogEntry[]>(initial?.syncLog ?? []);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);

  const pendingOperations = computed(() => operations.value.filter((op) => op.status !== "已确认"));
  const operationsNearCapacity = computed(() => operations.value.length >= NEAR_CAPACITY);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: pendingOperations.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function logSync(kind: SyncLogEntry["kind"], detail: string, withMetrics = false) {
    syncLog.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), kind, detail, ...(withMetrics ? { metrics: { ...metrics.value } } : {}) });
    if (syncLog.value.length > 100) syncLog.value.length = 100;
  }

  function enqueue(entity: string, action: string, detail: string) {
    operations.value.unshift({ seq: nextSeq.value++, entity, action, detail, time: new Date().toISOString(), status: "待同步", batchId: null });
    ensureCapacity();
  }

  /** 接近容量上限时先归档已确认操作，仍接近上限且在线则立即分批同步 */
  function ensureCapacity() {
    if (operations.value.length < NEAR_CAPACITY) return;
    compactOperations();
    if (operations.value.length >= NEAR_CAPACITY && online.value && !syncing.value) void syncNow();
  }

  function compactOperations() {
    const confirmed = operations.value.filter((op) => op.status === "已确认").sort((a, b) => b.seq - a.seq);
    if (confirmed.length <= KEEP_CONFIRMED) return;
    const keep = new Set(confirmed.slice(0, KEEP_CONFIRMED).map((op) => op.seq));
    const before = operations.value.length;
    operations.value = operations.value.filter((op) => op.status !== "已确认" || keep.has(op.seq));
    logSync("容量整理", `操作记录接近上限，已归档 ${before - operations.value.length} 条已确认操作，保留近 ${KEEP_CONFIRMED} 条`);
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    households.value.unshift({ ...input, id: crypto.randomUUID(), status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "新增", input.head);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "修改", `${household.head}：${Object.keys(patch).join("、")}`);
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    households.value = households.value.filter((item) => item.id !== sourceId);
    delete syncedSnapshots.value[sourceId];
    conflicts.value = conflicts.value.filter((item) => item.householdId !== sourceId);
    enqueue("重复记录", "合并", `${source.head} → ${target.address}`);
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    tasks.value.unshift({ ...input, id: crypto.randomUUID(), status: "待接收" });
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    enqueue("任务", "分派", `${input.title} / ${input.assignee}`);
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
    }
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`);
  }

  /** 幂等台账：同一编号重复提交只应用一次，返回 false 表示已应用过 */
  function markApplied(seq: number): boolean {
    if (appliedSeqs.value.includes(seq)) return false;
    appliedSeqs.value.push(seq);
    if (appliedSeqs.value.length > 500) appliedSeqs.value = appliedSeqs.value.slice(-500);
    return true;
  }

  function diffFields(base: Household | undefined, current: Household): (keyof Household)[] {
    if (!base) return [];
    return MERGE_FIELDS.filter((field) => JSON.stringify(base[field]) !== JSON.stringify(current[field]));
  }

  function formatValue(value: unknown): string {
    return Array.isArray(value) ? value.join("、") : String(value);
  }

  function parseValue(text: string, current: unknown): unknown {
    if (Array.isArray(current)) return text.split("、").filter(Boolean);
    if (typeof current === "number") return Number(text);
    return text;
  }

  /**
   * 三方合并单条远端记录：
   * - 两边都改过且不一致 → 生成冲突，本机值与远端值都保留，等人工确认
   * - 只有远端改过 → 采用远端；只有本机改过 → 照旧保留本机值
   */
  function mergeRemoteHousehold(remote: Household): { conflicts: number; applied: number } {
    const result = { conflicts: 0, applied: 0 };
    const local = households.value.find((item) => item.id === remote.id);
    if (!local) {
      households.value.push(deepCopy(remote));
      return result;
    }
    const base = syncedSnapshots.value[remote.id];
    const localChanged = diffFields(base, local);
    const remoteChanged = diffFields(base, remote);
    for (const field of remoteChanged) {
      const remoteValue = remote[field];
      const pending = conflicts.value.some((item) => item.householdId === local.id && item.field === field && item.status === "待处理");
      if (pending) continue;
      const rejected = conflicts.value.some((item) => item.householdId === local.id && item.field === field && item.status === "采用本地" && item.remoteValue === formatValue(remoteValue));
      if (rejected) continue;
      if (!localChanged.includes(field)) {
        (local as unknown as Record<string, unknown>)[field] = deepCopy(remoteValue);
        result.applied += 1;
      } else if (JSON.stringify(local[field]) !== JSON.stringify(remoteValue)) {
        conflicts.value.unshift({ id: crypto.randomUUID(), householdId: local.id, field, localValue: formatValue(local[field]), remoteValue: formatValue(remoteValue), status: "待处理" });
        result.conflicts += 1;
      }
    }
    if (result.applied || result.conflicts) {
      local.version = Math.max(local.version, remote.version) + 1;
      local.deviceUpdatedAt = new Date().toISOString();
    }
    return result;
  }

  /** 模拟远端版本：基于上次同步基线叠加对端改动 */
  function buildRemoteBatch(): Household[] {
    const remote = Object.values(syncedSnapshots.value).map((item) => deepCopy(item));
    const first = remote.find((item) => item.id === "h1") ?? remote[0];
    if (first) {
      first.address = "河湾路18号2栋2单元";
      first.version += 1;
      first.deviceUpdatedAt = new Date().toISOString();
    }
    const second = remote.find((item) => item.id === "h2");
    if (second) {
      second.note = "远端补充：已协调瓶装水2箱";
      second.version += 1;
      second.deviceUpdatedAt = new Date().toISOString();
    }
    return remote;
  }

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 网络恢复后按批次合并远端版本，再分批确认本地操作；失败保留未确认操作，重试幂等 */
  async function syncNow(): Promise<{ ok: boolean; message: string }> {
    if (syncing.value) return { ok: false, message: "同步进行中，请稍候。" };
    if (!online.value) return { ok: false, message: "仍在弱网状态，未确认操作已保留在设备中。" };
    syncing.value = true;
    const syncId = `B${Date.now().toString(36)}`;
    try {
      const remoteBatches = chunk(buildRemoteBatch(), BATCH_SIZE);
      let totalConflicts = 0;
      for (let i = 0; i < remoteBatches.length; i += 1) {
        await delay(200);
        if (!online.value) throw new Error("连接中断");
        let batchConflicts = 0;
        let batchApplied = 0;
        remoteBatches[i].forEach((item) => {
          const result = mergeRemoteHousehold(item);
          batchConflicts += result.conflicts;
          batchApplied += result.applied;
        });
        totalConflicts += batchConflicts;
        logSync("批次合并", `远端批次 ${i + 1}/${remoteBatches.length}（${remoteBatches[i].length} 条）：采用远端字段 ${batchApplied} 处，新增冲突 ${batchConflicts} 处`, true);
      }
      const pending = operations.value.filter((op) => op.status !== "已确认").sort((a, b) => a.seq - b.seq);
      const opBatches = chunk(pending, BATCH_SIZE);
      for (let i = 0; i < opBatches.length; i += 1) {
        const batch = opBatches[i];
        batch.forEach((op) => { op.status = "待同步"; op.batchId = `${syncId}-${i + 1}`; });
        await delay(150);
        if (!online.value) throw new Error("连接中断");
        const applied = batch.filter((op) => markApplied(op.seq));
        applied.forEach((op) => { op.status = "已确认"; });
        if (applied.length) logSync("批次合并", `本地操作批次 ${i + 1}/${opBatches.length}：确认 ${applied.length} 条（#${applied[0].seq}–#${applied[applied.length - 1].seq}）`, true);
      }
      households.value.forEach((item) => { syncedSnapshots.value[item.id] = deepCopy(item); });
      lastSyncedAt.value = new Date().toISOString();
      compactOperations();
      return { ok: true, message: totalConflicts ? `同步完成，发现 ${totalConflicts} 个字段冲突，请人工处理。` : "同步完成，无字段冲突。" };
    } catch {
      operations.value.filter((op) => op.batchId?.startsWith(syncId) && op.status !== "已确认").forEach((op) => { op.status = "同步失败"; });
      logSync("同步失败", "连接中断，未确认操作已保留；重试时同编号操作只应用一次，不重复建任务也不重复计数", true);
      return { ok: false, message: "同步失败，未确认操作已保留，可直接重试。" };
    } finally {
      syncing.value = false;
    }
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") {
      (household as unknown as Record<string, unknown>)[conflict.field] = parseValue(conflict.remoteValue, household[conflict.field]);
    }
    conflict.status = resolution;
    if (household) {
      household.version += 1;
      household.deviceUpdatedAt = new Date().toISOString();
      syncedSnapshots.value[household.id] = deepCopy(household);
    }
    const touchedTasks = tasks.value.filter((item) => item.householdId === conflict.householdId && item.status !== "已完成");
    if (household && conflict.field === "needLevel") touchedTasks.forEach((task) => { task.priority = household.needLevel; });
    const head = household?.head ?? conflict.householdId;
    enqueue("冲突处理", resolution, `${head} · ${conflict.field}`);
    logSync("冲突处理", `${head} · ${conflict.field} ${resolution}；改动待办：${touchedTasks.length ? touchedTasks.map((task) => task.title).join("、") : "无"}；指标已重算`, true);
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, operations, conflicts, appliedSeqs, nextSeq, syncedSnapshots, syncLog, lastSyncedAt], () => {
      const state: PersistedState = {
        schemaVersion: SCHEMA_VERSION,
        households: households.value,
        tasks: tasks.value,
        operations: operations.value,
        appliedSeqs: appliedSeqs.value,
        nextSeq: nextSeq.value,
        syncedSnapshots: syncedSnapshots.value,
        conflicts: conflicts.value,
        lastSyncedAt: lastSyncedAt.value,
        syncLog: syncLog.value
      };
      localStorage.setItem(KEY, JSON.stringify(state));
    }, { deep: true });
  }

  return { households, tasks, operations, pendingOperations, conflicts, syncLog, online, lastSyncedAt, syncing, metrics, duplicates, operationsNearCapacity, operationCapacity: OPERATION_CAPACITY, addHousehold, updateHousehold, mergeDuplicate, addTask, advanceTask, syncNow, resolveConflict, enqueue };
});
