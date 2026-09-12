/**
 * 平衡含水率估算的自检（`npm run test:emc`）。
 *
 * 这条公式写错过一次，把 26.4 ℃ / 78 % 算成了 −15.2 % —— 平衡含水率不可能小于 0，
 * 但页面上照显不误。加一个可执行的参考点检查，比在注释里写「请小心」有用。
 */

import { estimateEmc } from "../server/services/workflow.mjs";

/** 文献常引的基准点：20 ℃ / 65 % → 约 12 % */
const CASES = [
  { t: 20, rh: 65, expect: 12, tol: 0.3, why: "木材学常引基准点" },
  { t: 26.4, rh: 78, expect: 15.08, tol: 0.1, why: "演示会话的现场读数" },
  { t: 10, rh: 40, expect: null, tol: 999, why: "低温低湿应当明显低于基准点" },
];

let failed = 0;

for (const item of CASES) {
  const got = estimateEmc(item.t, item.rh);
  if (got === null) {
    console.error(`✗ ${item.t}℃/${item.rh}% 返回 null（${item.why}）`);
    failed += 1;
    continue;
  }
  if (got <= 0) {
    console.error(`✗ ${item.t}℃/${item.rh}% = ${got}：平衡含水率不可能小于 0（${item.why}）`);
    failed += 1;
    continue;
  }
  if (item.expect !== null && Math.abs(got - item.expect) > item.tol) {
    console.error(`✗ ${item.t}℃/${item.rh}% = ${got}，期望 ${item.expect}±${item.tol}（${item.why}）`);
    failed += 1;
    continue;
  }
  console.log(`✓ ${item.t}℃/${item.rh}% = ${got}%${item.expect !== null ? `（期望 ${item.expect}）` : ""} · ${item.why}`);
}

// 单调性：同一温度下湿度越高，EMC 必须越大
const low = estimateEmc(25, 40);
const high = estimateEmc(25, 80);
if (!(high > low)) {
  console.error(`✗ 单调性失败：25℃/40% = ${low}，25℃/80% = ${high}，后者应更大`);
  failed += 1;
} else {
  console.log(`✓ 单调性：25℃ 下 40% → ${low}% < 80% → ${high}%`);
}

// 越界输入应当返回 null，而不是编一个数
for (const [t, rh] of [[25, 0], [25, 100], [25, -5]]) {
  if (estimateEmc(t, rh) !== null) {
    console.error(`✗ ${t}℃/${rh}% 应当返回 null（超出物理范围）`);
    failed += 1;
  }
}
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
