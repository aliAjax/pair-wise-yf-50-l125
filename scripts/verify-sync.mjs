/* 临时验证脚本：在 Node 中真实加载 store，验证编号幂等 / 三方合并 / 失败保留 / 旧数据迁移 */
import assert from "node:assert";
import { createJiti } from "jiti";

const scenario = process.argv[2] ?? "sync";
const jiti = createJiti(import.meta.url);

if (scenario === "migrate") {
  const legacy = {
    households: [{ id: "h9", head: "李桂芳", community: "旧社区", address: "旧地址1号", members: 3, vulnerable: [], needLevel: "高", needs: ["食品"], status: "待评估", version: 1, deviceUpdatedAt: "2026-09-01T00:00:00.000Z", note: "旧数据" }],
    tasks: [],
    queue: [{ id: "q1", entity: "家庭需求记录", action: "新增", detail: "李桂芳", time: "2026-09-01T01:00:00.000Z" }],
    conflicts: [{ id: "c1", householdId: "h9", field: "address", localValue: "旧地址1号", remoteValue: "旧地址2号", status: "待处理" }],
    lastSyncedAt: "2026-09-01T02:00:00.000Z"
  };
  const backing = { "pair-wise-yf-50/assessment": JSON.stringify(legacy) };
  globalThis.window = {};
  globalThis.localStorage = { getItem: (k) => backing[k] ?? null, setItem: (k, v) => { backing[k] = v; }, removeItem: (k) => { delete backing[k]; } };
}

const { createPinia, setActivePinia } = await jiti.import("pinia");
const { useAssessmentStore } = await jiti.import("../stores/assessment.ts");
setActivePinia(createPinia());
const store = useAssessmentStore();

if (scenario === "capacity") {
  for (let i = 0; i < 100; i += 1) store.updateHousehold("h3", { note: `离线修改 ${i}` });
  assert.ok(store.operationsNearCapacity || store.syncing, "接近上限时触发分批处理");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.ok(store.operations.length <= 100, `容量受控，当前 ${store.operations.length} 条`);
  assert.ok(store.operations.some((op) => op.status === "已确认" && op.batchId), "操作已按批次确认");
  assert.ok(store.syncLog.some((e) => e.kind === "批次合并" || e.kind === "容量整理"), "分批处理写入日志");
  const confirmed = store.operations.filter((op) => op.status === "已确认");
  assert.ok(confirmed.length <= 20, `已确认操作归档保留近 20 条，当前 ${confirmed.length} 条`);
  console.log("capacity scenario OK");
} else if (scenario === "migrate") {
  assert.equal(store.households.length, 1, "旧家庭记录保留");
  assert.equal(store.households[0].head, "李桂芳");
  assert.equal(store.operations.length, 1, "旧队列迁移为带编号操作");
  assert.equal(store.operations[0].seq, 1);
  assert.equal(store.operations[0].status, "待同步");
  assert.equal(store.conflicts.length, 1, "旧冲突保留可打开");
  assert.equal(store.conflicts[0].status, "待处理");
  assert.ok(store.syncLog.some((e) => e.kind === "数据升级"), "记录数据升级日志");
  store.resolveConflict("c1", "采用本地");
  assert.equal(store.conflicts[0].status, "采用本地", "旧冲突可正常处理");
  assert.equal(store.operations[0].seq, 2, "冲突处理生成新编号操作");
  const result = await store.syncNow();
  assert.equal(result.ok, true);
  assert.equal(store.metrics.queued, 0, "迁移后同步可确认全部操作");
  console.log("migrate scenario OK");
} else {
  // 1) 改动生成带编号操作
  store.updateHousehold("h3", { note: "现场无水，需紧急送水" });
  store.addTask({ householdId: "h3", title: "送水上门", assignee: "救援一组", priority: "紧急", due: "2026-09-30 18:00" });
  assert.equal(store.operations.length, 2);
  assert.deepEqual(store.operations.map((op) => op.seq).sort((a, b) => a - b), [1, 2], "操作带递增编号");
  assert.equal(store.metrics.queued, 2);

  // 2) 同步：三方合并 + 分批确认
  const first = await store.syncNow();
  assert.equal(first.ok, true);
  const h1 = store.households.find((h) => h.id === "h1");
  const h2 = store.households.find((h) => h.id === "h2");
  const h3 = store.households.find((h) => h.id === "h3");
  const conflict = store.conflicts.find((c) => c.householdId === "h1" && c.field === "address");
  assert.ok(conflict, "两边都改过的字段生成冲突");
  assert.equal(conflict.status, "待处理");
  assert.equal(conflict.localValue, "河湾路18号2单元", "冲突保留本机值");
  assert.equal(conflict.remoteValue, "河湾路18号2栋2单元", "冲突保留远端值");
  assert.equal(h1.address, "河湾路18号2单元", "冲突未确认前本机值不被覆盖");
  assert.equal(h2.note, "远端补充：已协调瓶装水2箱", "只有远端改过的字段采用远端");
  assert.equal(h3.note, "现场无水，需紧急送水", "只有本机改过的字段照旧保留");
  assert.equal(store.metrics.queued, 0, "同步后无待确认操作");
  assert.ok(store.operations.every((op) => op.status === "已确认"));
  assert.ok(store.syncLog.some((e) => e.kind === "批次合并" && e.metrics), "批次合并记录指标快照");

  // 3) 幂等：重复同步不重复应用、不重复计数
  const opCount = store.operations.length;
  const conflictCount = store.conflicts.length;
  const taskCount = store.tasks.length;
  await store.syncNow();
  assert.equal(store.operations.length, opCount, "重复同步不产生新操作");
  assert.equal(store.conflicts.length, conflictCount, "同一冲突不重复生成");
  assert.equal(store.tasks.length, taskCount, "重试不重复建任务");
  assert.equal(store.metrics.queued, 0, "不重复计数");

  // 4) 冲突处理：记录改动待办与指标重算
  store.resolveConflict(conflict.id, "采用远端");
  assert.equal(h1.address, "河湾路18号2栋2单元", "采用远端后应用远端值");
  const log = store.syncLog.find((e) => e.kind === "冲突处理");
  assert.ok(log, "冲突处理写入日志");
  assert.ok(log.detail.includes("指标已重算"));
  assert.ok(log.metrics, "日志带重算后的指标");
  assert.ok(store.operations.some((op) => op.entity === "冲突处理" && op.status === "待同步"), "冲突处理本身也生成待同步操作");

  // 5) 同步失败：保留未确认操作，恢复后重试幂等
  store.online = false;
  const beforeFail = store.pendingOperations.length;
  const failed = await store.syncNow();
  assert.equal(failed.ok, false);
  assert.equal(store.pendingOperations.length, beforeFail, "失败保留未确认操作");
  store.online = true;
  const retry = await store.syncNow();
  assert.equal(retry.ok, true);
  assert.equal(store.metrics.queued, 0, "重试后全部确认");
  assert.equal(store.tasks.length, taskCount, "重试后任务数不变");
  console.log("sync scenario OK");
}
