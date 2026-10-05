import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";
export type OpStatus = "pending" | "synced" | "failed";
export type OpAction = "create" | "update" | "merge" | "assign" | "advance" | "resolve";

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

/** 带编号的操作：每次改动对应一条，opId 即幂等键，重复提交同一编号只应用一次。 */
export interface Op {
  opId: number;
  entity: "household" | "task";
  entityId: string;
  action: OpAction;
  /** 参与字段级合并的字段名；create/assign 为整实体新增。 */
  fields: string[];
  detail: string;
  time: string;
  status: OpStatus;
  /** 该操作在第几批合并中应用。 */
  batchId?: number;
}

export interface PendingChange {
  id: string;
  opId: number;
  entity: string;
  action: string;
  detail: string;
  time: string;
  status: OpStatus;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
  opId?: number;
}

interface PersistShape {
  version: number;
  households: Household[];
  tasks: FieldTask[];
  ops: Op[];
  conflicts: FieldConflict[];
  remoteHouseholds: Household[];
  remoteTasks: FieldTask[];
  snapshot: { households: Household[]; tasks: FieldTask[] };
  nextOpId: number;
  lastSyncedAt: string;
}

const KEY = "pair-wise-yf-50/assessment";
const DATA_VERSION = 2;
/** 每批合并的操作数，网络恢复后按批次合并远端版本。 */
const BATCH_SIZE = 5;
/** 操作记录接近容量上限时先分批处理，避免丢弃现场记录。 */
const MAX_OPS = 100;

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

/** 最近一次同步时的共同祖先（本地与远端都从这里分叉）。 */
const seedSnapshotHouseholds: Household[] = seedHouseholds.map((h) => (h.id === "h1" ? { ...h, note: "一层受淹" } : { ...h }));
/** 远端（服务器）版本：h1 的地址与说明被服务器侧改过，用于演示字段级合并。 */
const seedRemoteHouseholds: Household[] = seedHouseholds.map((h) =>
  h.id === "h1" ? { ...h, address: "河湾路18号2栋2单元", note: "一层受淹，老人行动不便（远端核实）" } : { ...h }
);
/** 一条已离线、尚未确认的改动：现场人员把 h1 的说明改长了。 */
const seedOps: Op[] = [
  { opId: 1, entity: "household", entityId: "h1", action: "update", fields: ["note"], detail: "离线修改 h1 现场说明", time: new Date(Date.now() - 5 * 60000).toISOString(), status: "pending" }
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function chunk<T>(list: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < list.length; i += size) rows.push(list.slice(i, i + size));
  return rows;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function actionLabel(action: OpAction): string {
  switch (action) {
    case "create": return "新增";
    case "update": return "修改";
    case "merge": return "合并";
    case "assign": return "分派";
    case "advance": return "状态流转";
    case "resolve": return "冲突处理";
  }
}

/** 旧数据升级：保留原有家庭记录与冲突，旧队列补编号后仍能打开、继续同步。 */
function migrateV1(parsed: any): PersistShape {
  const households: Household[] = Array.isArray(parsed?.households) && parsed.households.length ? parsed.households : clone(seedHouseholds);
  const tasks: FieldTask[] = Array.isArray(parsed?.tasks) && parsed.tasks.length ? parsed.tasks : clone(seedTasks);
  const conflicts: FieldConflict[] = (Array.isArray(parsed?.conflicts) ? parsed.conflicts : []).map((c: any) => ({
    id: c?.id ?? crypto.randomUUID(),
    householdId: c?.householdId ?? "",
    field: c?.field ?? "note",
    localValue: c?.localValue ?? "",
    remoteValue: c?.remoteValue ?? "",
    status: c?.status ?? "待处理",
    opId: undefined
  }));
  const oldQueue: any[] = Array.isArray(parsed?.queue) ? parsed.queue : [];
  const ops: Op[] = oldQueue.map((q, i) => ({
    opId: i + 1,
    entity: q?.entity === "任务" ? "task" : "household",
    entityId: q?.entityId ?? "",
    action: "update",
    fields: [],
    detail: q?.detail ?? "旧数据升级",
    time: q?.time ?? new Date().toISOString(),
    status: "pending"
  }));
  return {
    version: DATA_VERSION,
    households,
    tasks,
    ops,
    conflicts,
    // 升级后远端与本地一致，避免对旧记录产生凭空冲突；原有冲突已单独保留。
    remoteHouseholds: clone(households),
    remoteTasks: clone(tasks),
    snapshot: { households: clone(households), tasks: clone(tasks) },
    nextOpId: ops.length + 1,
    lastSyncedAt: parsed?.lastSyncedAt ?? new Date().toISOString()
  };
}

function loadState(): PersistShape | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === DATA_VERSION && Array.isArray(parsed.ops)) return parsed as PersistShape;
    return migrateV1(parsed);
  } catch {
    return null;
  }
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = loadState();
  const households = ref<Household[]>(initial?.households ?? clone(seedHouseholds));
  const tasks = ref<FieldTask[]>(initial?.tasks ?? clone(seedTasks));
  const remoteHouseholds = ref<Household[]>(initial?.remoteHouseholds ?? clone(seedRemoteHouseholds));
  const remoteTasks = ref<FieldTask[]>(initial?.remoteTasks ?? clone(seedTasks));
  const snapshot = ref<{ households: Household[]; tasks: FieldTask[] }>(
    initial?.snapshot ?? { households: clone(seedSnapshotHouseholds), tasks: clone(seedTasks) }
  );
  const ops = ref<Op[]>(initial?.ops ?? clone(seedOps));
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const nextOpId = ref(initial?.nextOpId ?? 2);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);
  const metricsVersion = ref(0);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: ops.value.filter((item) => item.status !== "synced").length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  /** 待同步队列：由未确认操作派生，编号即 opId，重复提交不会重复计数。 */
  const queue = computed<PendingChange[]>(() =>
    ops.value
      .filter((item) => item.status !== "synced")
      .map((item) => ({
        id: String(item.opId),
        opId: item.opId,
        entity: item.entity === "task" ? "任务" : "家庭需求记录",
        action: actionLabel(item.action),
        detail: item.detail,
        time: item.time,
        status: item.status
      }))
  );

  /** 操作记录接近容量上限时先分批处理：已确认的清理，未确认的按批次提交。 */
  function ensureCapacity() {
    if (ops.value.length < MAX_OPS) return;
    ops.value = ops.value.filter((item) => item.status !== "synced");
    if (ops.value.length >= MAX_OPS && online.value && !syncing.value) {
      void simulateSync();
    }
  }

  /** 记录一条带编号的操作；同编号重复提交只应用一次。 */
  function recordOp(input: { entity: "household" | "task"; entityId: string; action: OpAction; fields: string[]; detail: string }): Op {
    ensureCapacity();
    const op: Op = {
      opId: nextOpId.value++,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      fields: input.fields,
      detail: input.detail,
      time: new Date().toISOString(),
      status: "pending"
    };
    ops.value.push(op);
    return op;
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    const id = crypto.randomUUID();
    households.value.unshift({ ...input, id, status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString() });
    recordOp({ entity: "household", entityId: id, action: "create", fields: [], detail: `新增 ${input.head}` });
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    recordOp({ entity: "household", entityId: id, action: "update", fields: Object.keys(patch), detail: `修改 ${household.head}：${Object.keys(patch).join("、")}` });
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
    recordOp({ entity: "household", entityId: targetId, action: "merge", fields: ["needs", "vulnerable", "note"], detail: `合并重复记录 ${source.head} → ${target.address}` });
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    const id = crypto.randomUUID();
    tasks.value.unshift({ ...input, id, status: "待接收" });
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    recordOp({ entity: "task", entityId: id, action: "assign", fields: [], detail: `分派任务 ${input.title} / ${input.assignee}` });
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
    recordOp({ entity: "task", entityId: id, action: "advance", fields: ["status"], detail: `任务状态流转 ${task.title} → ${task.status}` });
  }

  /** 应用一批操作：字段级三方合并（本地 / 远端 / 共同祖先）。 */
  function applyBatch(batch: Op[], batchId: number): { applied: number; conflicts: FieldConflict[] } {
    const newConflicts: FieldConflict[] = [];
    let applied = 0;
    for (const op of batch) {
      if (op.status === "synced") continue; // 幂等：同一编号只应用一次
      op.batchId = batchId;

      if (op.action === "create" || op.action === "assign") {
        const remoteList = op.entity === "household" ? remoteHouseholds.value : remoteTasks.value;
        const localList = op.entity === "household" ? households.value : tasks.value;
        if (!remoteList.find((item: { id: string }) => item.id === op.entityId)) {
          const entity = localList.find((item: { id: string }) => item.id === op.entityId);
          if (entity) remoteList.push(clone(entity));
        }
        op.status = "synced";
        applied++;
        continue;
      }

      const localList = op.entity === "household" ? households.value : tasks.value;
      const remoteList = op.entity === "household" ? remoteHouseholds.value : remoteTasks.value;
      const snapList = op.entity === "household" ? snapshot.value.households : snapshot.value.tasks;
      // 旧数据升级上来的操作没有 entityId，无法做字段级合并，按无争议确认处理。
      if (!op.entityId) {
        op.status = "synced";
        applied++;
        continue;
      }
      const localEntity = localList.find((item: { id: string }) => item.id === op.entityId);
      const remoteEntity = remoteList.find((item: { id: string }) => item.id === op.entityId);
      const snapEntity = snapList.find((item: { id: string }) => item.id === op.entityId);
      if (!localEntity || !remoteEntity) {
        op.status = "failed";
        continue;
      }

      for (const field of op.fields) {
        // 已有未处理冲突的字段先跳过，等人工确认，不静默覆盖。
        const existing = conflicts.value.find((item) => item.householdId === op.entityId && item.field === field && item.status === "待处理");
        if (existing) continue;
        const localVal = (localEntity as Record<string, unknown>)[field];
        const remoteVal = (remoteEntity as Record<string, unknown>)[field];
        const snapVal = snapEntity ? (snapEntity as Record<string, unknown>)[field] : undefined;
        const localChanged = !isEqual(localVal, snapVal);
        const remoteChanged = !isEqual(remoteVal, snapVal);
        if (localChanged && remoteChanged) {
          // 两边都改过：保留本地值与远端值，等人工确认。
          const conflict: FieldConflict = {
            id: crypto.randomUUID(),
            householdId: op.entityId,
            field: field as keyof Household,
            localValue: String(localVal),
            remoteValue: String(remoteVal),
            status: "待处理",
            opId: op.opId
          };
          conflicts.value.unshift(conflict);
          newConflicts.push(conflict);
        } else if (localChanged) {
          // 只有本机改过：照旧采用。
          (remoteEntity as Record<string, unknown>)[field] = localVal;
        }
      }
      op.status = "synced";
      applied++;
    }
    return { applied, conflicts: newConflicts };
  }

  /** 拉取远端仅有的改动到本地（只有远端改过、本机没动过的字段）。 */
  function pullRemoteOnly() {
    const pull = (remoteList: { id: string }[], localList: { id: string }[], snapList: { id: string }[]) => {
      for (const remoteEntity of remoteList) {
        const localEntity = localList.find((item) => item.id === remoteEntity.id);
        const snapEntity = snapList.find((item) => item.id === remoteEntity.id);
        if (!localEntity || !snapEntity) continue;
        for (const field of Object.keys(remoteEntity)) {
          const remoteVal = (remoteEntity as Record<string, unknown>)[field];
          const snapVal = (snapEntity as Record<string, unknown>)[field];
          const localVal = (localEntity as Record<string, unknown>)[field];
          const remoteChanged = !isEqual(remoteVal, snapVal);
          const localChanged = !isEqual(localVal, snapVal);
          if (remoteChanged && !localChanged) {
            (localEntity as Record<string, unknown>)[field] = remoteVal;
          }
        }
      }
    };
    pull(remoteHouseholds.value, households.value, snapshot.value.households);
    pull(remoteTasks.value, tasks.value, snapshot.value.tasks);
  }

  /** 网络恢复后按批次合并远端版本；失败则保留未确认操作，重试不重复建任务、不重复计数。 */
  async function simulateSync(): Promise<{ applied: number; conflicts: FieldConflict[]; failed: boolean; batches: number }> {
    if (syncing.value) return { applied: 0, conflicts: [], failed: false, batches: 0 };
    syncing.value = true;
    const pending = ops.value.filter((item) => item.status === "pending" || item.status === "failed");
    const batches = chunk(pending, BATCH_SIZE);
    let applied = 0;
    const found: FieldConflict[] = [];
    let failed = false;
    for (let i = 0; i < batches.length; i++) {
      if (!online.value) {
        batches[i].forEach((op) => {
          if (op.status !== "synced") op.status = "failed";
        });
        failed = true;
        break;
      }
      await delay(320);
      const res = applyBatch(batches[i], i + 1);
      applied += res.applied;
      found.push(...res.conflicts);
    }
    if (!failed) {
      pullRemoteOnly();
      snapshot.value = { households: clone(remoteHouseholds.value), tasks: clone(remoteTasks.value) };
      lastSyncedAt.value = new Date().toISOString();
    }
    syncing.value = false;
    return { applied, conflicts: found, failed, batches: batches.length };
  }

  /** 冲突处理后：记录改动过的待办（操作），并触发指标重算。 */
  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    const remoteHousehold = remoteHouseholds.value.find((item) => item.id === conflict.householdId);
    const snapHousehold = snapshot.value.households.find((item) => item.id === conflict.householdId);
    const chosen = resolution === "采用远端" ? conflict.remoteValue : conflict.localValue;
    if (household) (household as Record<string, unknown>)[conflict.field] = chosen;
    if (remoteHousehold) (remoteHousehold as Record<string, unknown>)[conflict.field] = chosen;
    if (snapHousehold) (snapHousehold as Record<string, unknown>)[conflict.field] = chosen;
    conflict.status = resolution;
    if (household) {
      household.version += 1;
      household.deviceUpdatedAt = new Date().toISOString();
    }
    recordOp({ entity: "household", entityId: conflict.householdId, action: "resolve", fields: [conflict.field as string], detail: `冲突处理 ${conflict.field} → ${resolution}` });
    recomputeMetrics();
  }

  function recomputeMetrics() {
    // metrics 为 computed，依赖变更后自动重算；此处显式自增版本号标记一次重算。
    metricsVersion.value += 1;
  }

  function enqueue(entity: string, action: string, detail: string) {
    recordOp({ entity: entity === "任务" ? "task" : "household", entityId: "", action: "update", fields: [], detail });
  }

  if (typeof window !== "undefined") {
    watch(
      [households, tasks, ops, conflicts, remoteHouseholds, remoteTasks, snapshot, lastSyncedAt, nextOpId],
      () => {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            version: DATA_VERSION,
            households: households.value,
            tasks: tasks.value,
            ops: ops.value,
            conflicts: conflicts.value,
            remoteHouseholds: remoteHouseholds.value,
            remoteTasks: remoteTasks.value,
            snapshot: snapshot.value,
            nextOpId: nextOpId.value,
            lastSyncedAt: lastSyncedAt.value
          })
        );
      },
      { deep: true }
    );
  }

  return {
    households,
    tasks,
    queue,
    conflicts,
    online,
    lastSyncedAt,
    syncing,
    metrics,
    metricsVersion,
    duplicates,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    advanceTask,
    simulateSync,
    resolveConflict,
    recomputeMetrics,
    enqueue
  };
});
