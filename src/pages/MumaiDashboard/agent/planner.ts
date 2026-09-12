/**
 * 小木语音智能体 · Agent Planner（技术方案 §19 / §23 / §52）
 *
 * 方案里这一步由本地 LLM 完成。本演示不部署大模型（PRD 4.1），
 * 因此用一个**可解释的规则规划器**替代：它做的事情与 LLM Planner 完全同构 ——
 *
 *   一句话 →（语言理解）→ 目标 + 有序动作序列 → 结构化 plan（§23 的 JSON 形态）
 *
 * 差别只在「语言理解」这一层：LLM 靠权重，这里靠
 *   1) 顺序词切分子句（先…再…然后…最后）
 *   2) 柱号词典（「一号木柱 / 2号柱」→ Z01 / Z02，词典来自 seed 的 COMPONENTS）
 *   3) 动作词典（环绕 / 拍摄 / 扫描 / 返回 / 停止）
 * 之所以可以这么做：剧本里的多步任务句式是有限的（方案 §2「简单问题不走 LLM」、
 * §57 建议先把规则链路做稳）。
 *
 * plan 里的每一步都是一个 Tool Registry 里的白名单工具（§21 / §44），
 * 规划器不能凭空造工具名。
 */

import { COMPONENTS, MISSION, WAYPOINTS } from "../seed/scenario";
import { normalize } from "./lang";
import { normalizePillar } from "./lib/entities";
import { plannedPathLength, routeDistance } from "./lib/geo";
import type { EntityBag } from "./types";

/** 方案 §23 的 plan 形态：goal + steps[{tool, args}]，额外带一句给观众看的中文说明 */
export type PlanStepSpec = {
  tool: string;
  args: Record<string, string>;
  /** 这一步在做什么（会显示在步骤清单上，例如「正在环绕一号木柱」） */
  label: string;
  /** 执行前的准备态文案（例如「正在前往一号木柱」） */
  runningMessage: string;
  /** 执行完成文案 */
  doneMessage: string;
  /** 步骤之间的真实延时（毫秒），让观众看清执行过程 */
  delayMs: number;
};

export type TaskPlan = {
  goal: string;
  /** 目标构件（顺序执行） */
  targets: string[];
  /** 是否环绕采集 */
  circle: boolean;
  /** 是否返回起点 */
  returnHome: boolean;
  /** 路线一句话，用于回复模板的 {routeText} */
  routeText: string;
  /** 计划里程（米），由平台计划路径算出 */
  distanceM: number;
  steps: PlanStepSpec[];
};

const CIRCLE_WORDS = ["环绕", "绕一圈", "转一圈", "绕一圈", "拍摄一圈", "拍一圈", "绕柱", "绕一圏", "走一圈", "巡视一圈", "采集一圈"];
const RETURN_WORDS = ["返回", "回来", "回起点", "回到起点", "回原位", "回殿门", "返航", "回充电站"];
const SCAN_WORDS = ["扫描", "精扫", "采集数据", "测一遍"];

/** 顺序词：用于把一句话切成有序子句（§23 的 action_1 / action_2 / action_3） */
const ORDER_MARKERS = /(然后|接着|再|之后|最后|随后|而后|先)/g;

function mentions(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(normalize(word)) );
}

/** 从一句话里按出现顺序抽出全部目标构件 */
export function extractTargets(raw: string): string[] {
  const text = normalize(raw);
  const hits: { at: number; id: string }[] = [];
  // 分段扫描：只认「去/到/前往/经过/派到/开到/移动到」后面跟的柱号
  const actionWords = ["去", "到", "前往", "经过", "派到", "开到", "移动到", "走向", "依次"];
  actionWords.forEach((word) => {
    let from = 0;
    for (;;) {
      const at = text.indexOf(word, from);
      if (at < 0) break;
      // 动作词后 8 个字内找柱号说法
      const window = text.slice(at, at + 8);
      const id = normalizePillar(window);
      if (id) hits.push({ at, id });
      from = at + word.length;
    }
  });
  if (hits.length === 0) {
    // 没写动作词时全局找一次（「一号柱环绕一圈」）
    const id = normalizePillar(text);
    if (id) hits.push({ at: 0, id });
  }
  // 去重且保序
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.at - b.at)
    .map((item) => item.id)
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/** 把一句话切成有序子句，便于逐句判定动作（顺序词同时也是方案 §23 的 action_1/2/3 依据） */
function clauses(raw: string): string[] {
  return normalize(raw)
    .split(ORDER_MARKERS)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 规划入口：把「让小车先去一号木柱，再绕一圈，然后回来」解析成结构化 plan。
 * entities.pillar 作为兜底目标（单目标说法由 matcher 抽好槽位）。
 */
export function planTask(raw: string, entities: EntityBag): TaskPlan {
  const text = normalize(raw);
  const parts = clauses(raw);
  const targets = extractTargets(raw);
  const fallbackTarget = normalizePillar(entities.pillar) ?? COMPONENTS.find((item) => item.radarScore !== null)?.id ?? COMPONENTS[0].id;
  const finalTargets = targets.length ? targets : [fallbackTarget];

  const circle = mentions(text, CIRCLE_WORDS) && parts.some((part) => mentions(part, CIRCLE_WORDS));
  const returnHome = mentions(text, RETURN_WORDS);
  const scan = parts.some((part) => mentions(part, SCAN_WORDS));

  const componentOf = (id: string) => COMPONENTS.find((item) => item.id === id);
  const waypointOf = (id: string) => WAYPOINTS.find((item) => item.componentId === id);
  const home = WAYPOINTS.find((item) => item.componentId === null) ?? WAYPOINTS[0];
  const homeCell = home?.cell ?? [0, 0];
  const startCell = WAYPOINTS[WAYPOINTS.length - 1]?.cell ?? homeCell;

  const steps: PlanStepSpec[] = [];
  let lastCell: [number, number] = startCell;
  let travelled = 0;

  finalTargets.forEach((id, index) => {
    const component = componentOf(id);
    const waypoint = waypointOf(id);
    if (!component || !waypoint) return;
    travelled += routeDistance(lastCell, waypoint.cell);
    lastCell = waypoint.cell;
    const ordinal = ["首先", "接着", "随后", "然后"][index] ?? "然后";
    steps.push({
      tool: "robot_move",
      args: { target: id },
      // 构件名本身已带编号（"檐柱 Z01"），再拼一次 id 会渲染成
      // 「首先前往 Z01 檐柱 Z01」这种重复编号
      label: `${ordinal}前往 ${component.name}`,
      runningMessage: `正在前往${component.name}`,
      doneMessage: `已到达 ${waypoint.id} · ${waypoint.label}`,
      delayMs: 900,
    });
    if (scan) {
      steps.push({
        tool: "start_scan",
        args: {},
        label: `在 ${id} 采集原始数据`,
        runningMessage: `正在 ${id} 采集数据`,
        doneMessage: `${id} 数据采集已开始`,
        delayMs: 700,
      });
    }
  });

  if (circle) {
    const circleTarget = finalTargets[finalTargets.length - 1] ?? finalTargets[0];
    const component = componentOf(circleTarget);
    steps.push({
      tool: "robot_circle_target",
      args: { target: circleTarget },
      label: `环绕 ${circleTarget} 采集一周`,
      runningMessage: `正在环绕${component?.name ?? circleTarget}`,
      doneMessage: `${circleTarget} 环绕采集完成`,
      delayMs: 1800,
    });
  }

  if (returnHome || steps.length > 0) {
    steps.push({
      tool: "robot_return_home",
      args: {},
      label: "返回起点并上报结果",
      runningMessage: "正在返回起点",
      doneMessage: `已返回 ${home?.label ?? "起点"}`,
      delayMs: 900,
    });
    travelled += routeDistance(lastCell, homeCell);
  }

  const routeText = [home?.label ?? "起点", ...finalTargets.map((id) => `${id} 观察点`), home?.label ?? "起点"].join(" → ");
  const goalParts = [`前往 ${finalTargets.join("、")}`];
  if (circle) goalParts.push("环绕采集一周");
  if (scan) goalParts.push("采集原始数据");
  goalParts.push("返回起点");

  return {
    goal: goalParts.join(" → "),
    targets: finalTargets,
    circle,
    returnHome: returnHome || steps.length > 0,
    routeText,
    distanceM: Math.round(travelled * 10) / 10 || plannedPathLength(),
    steps,
  };
}

/** 供回复模板使用的补充事实（{goal} / {routeText} / {planSummary}） */
export function planFacts(plan: TaskPlan): Record<string, string> {
  return {
    goal: plan.goal,
    routeText: plan.routeText,
    planSummary: plan.steps.map((step, index) => `${index + 1}. ${step.label}`).join("；"),
    planDistance: `${plan.distanceM} m`,
    planStepCount: String(plan.steps.length),
    missionSpeed: MISSION.speedProfile,
  };
}
