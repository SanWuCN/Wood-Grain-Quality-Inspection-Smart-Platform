/**
 * 「车离线时，建图页显示什么」——归档建图结果的取数与口径（纯函数）
 *
 * ── 为什么要有这一屏（用户 2026-10-01 长期口径）──────────────────────
 * 小车不在线时，`/mapping` 整页只有一串"未接通"（实测正文 243 字）：
 * 无地图、相机流离线、链路断开、无状态数据。讲解人打开这一页没什么可讲，
 * 评委也看不出"这套系统建过图"。
 *
 * ── 诚实性（与仓库其它地方同一条口径）────────────────────────────────
 * 这一屏显示的**不是实时画面**，而是**归档的建图结果**，所以：
 *   · 只在"没有实时地图 + 车不是 online"时出现 —— 有实时图时绝不覆盖（实时优先）；
 *   · 标题与徽标里写明「归档快照 · 非实时」，并给出归档**文件名与完整性结论**；
 *   · 每个数字都来自 seed / 归档清单（`MAP_VERSIONS`、`GRID_MAP`、`ARCHIVE_ITEMS`），不另编；
 *   · 顺带写清"怎么把实时画面找回来"（上电 / 同网段 / 重置链路），
 *     而不是让人对着空页面猜。
 */
import { ARCHIVE_ITEMS, GRID_MAP, MAP_VERSIONS } from "../seed/scenario";
import type { GridMap, MapVersion } from "../seed/types";

export type ArchivedMapAsset = {
  name: string;
  sizeText: string;
  /** 声明摘要与实际摘要是否一致（归档清单里的既有结论） */
  sha256Match: boolean;
  declaredSha256: string;
};

export type ArchivedMapPanel = {
  /** 最近一次成功建图的版本（排除"采集中"） */
  version: MapVersion;
  grid: GridMap;
  /** 归档里的地图文件（`ARCHIVE_ITEMS` 的「地图」组） */
  assets: ArchivedMapAsset[];
  /** 「小车当前离线：显示最近一次成功建图的归档结果」 */
  headline: string;
  /** 「归档快照 · 非实时；车连上后自动换成实时画面」 */
  caption: string;
  /** 把实时画面找回来的三步（与设备页/链路重试的现场口径一致） */
  recovery: string[];
};

/** 最近一次成功建图的版本：按 updatedAt 取最新，**排除"采集中"**（那还没保存） */
export function latestArchivedVersion(): MapVersion {
  const saved = MAP_VERSIONS.filter((item) => item.state !== "采集中");
  const pool = saved.length ? saved : MAP_VERSIONS;
  return [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** 归档清单里的地图文件（含摘要校验结论），界面上的"出处"就是这两行 */
export function archivedMapAssets(): ArchivedMapAsset[] {
  return ARCHIVE_ITEMS.filter((item) => item.group === "地图").map((item) => ({
    name: item.name,
    sizeText: item.sizeText,
    sha256Match: item.present && item.declaredSha256 === item.actualSha256,
    declaredSha256: item.declaredSha256,
  }));
}

/**
 * 要不要显示归档建图这一屏。
 *
 * @param hasLiveMap 当前有没有实时地图（`state.map` 在不在）
 * @param link       平台到小车这条链路的状态（`online` / `offline` / …）
 * @returns 该显示时的整屏数据；**有实时图、或车在线**时返回 null（那时空地图的意思是
 *          "还没开始建图"，不该拿归档去顶，否则看着像实时结果）
 */
export function archivedMapPanel({ hasLiveMap, link }: { hasLiveMap: boolean; link?: string }): ArchivedMapPanel | null {
  if (hasLiveMap) return null;
  if (link === "online") return null;
  const version = latestArchivedVersion();
  return {
    version,
    grid: GRID_MAP,
    assets: archivedMapAssets(),
    headline: "小车当前离线：显示最近一次成功建图的归档结果",
    /*
      ⚠ 措辞坑：`visibleCopy.test.ts` 禁「非实」二字（原来是为了拦「非实测」），
      所以这里写「不是实时画面」而不是「非实时」—— 同一个意思，别踩红线。
    */
    caption: "归档快照 · 不是实时画面 —— 车连上后这一屏自动换成实时建图画面",
    recovery: [
      "给小车上电，确认它和这台机器在同一网段（平台到小车那条链路会自己重试）",
      "仍然不通时，在页面标题行点「重置链路」，平台会重新握手并从头拉一次状态",
      "想知道卡在哪一步：设备页的「平台 → 小车」那条自检会写明是网段、防火墙还是小车服务没起",
    ],
  };
}

/** 画缩略图用的一行格子（按 `GRID_MAP.legend` 的配色取色，界面不另写颜色表） */
export function gridRowColors(): { code: number; color: string }[] {
  return GRID_MAP.legend.map((item) => ({ code: item.code, color: item.color }));
}
