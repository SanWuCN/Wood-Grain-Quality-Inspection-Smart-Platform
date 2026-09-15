/**
 * 北京市相对湿度（外网数据，给「硬件详情 · 采集作业」右侧实时数据里的
 * 「相对湿度」用）。
 *
 * 为什么是外网而不是扫描枪：SensorTag 的湿度通道要蓝牙连上才有值，
 * 演示时枪常常不在线，那一格就一直空着。改成取北京市的相对湿度，
 * 面板上就始终有一个真实的数字。
 *
 * 三级取值，任何一级都不能是空白：
 *   1. `live`  —— 现场能上外网：直接取当前值（Open-Meteo，免密钥）；
 *   2. `cache` —— 取不到网（会场断网、接口不通）：用上一次成功取到的值，
 *                 并**在界面上标明是缓存**，不把旧数据画成实时；
 *   3. `fallback` —— 连缓存都没有（首次打开就断网）：给一个北京秋季的
 *                 常湿常量，同样标明来源，绝不留空。
 *
 * 只请求 `relative_humidity_2m` 一个字段：面板上只有这一格用它，
 * 多取字段既没必要，也放大了断网时的失败面。
 */

import { useEffect, useState } from "react";
import type { Tone } from "../lib";

/** 请求点：天安门（北京市中心），与「北京市」这个口径一致 */
const BEIJING = { latitude: 39.9042, longitude: 116.4074 } as const;

/**
 * 数据源。Open-Meteo 免密钥、带 CORS，浏览器可以直接取；
 * 换成别的服务（或走后端代理）只改这一个常量。
 */
export const HUMIDITY_ENDPOINT =
  `https://api.open-meteo.com/v1/forecast?latitude=${BEIJING.latitude}&longitude=${BEIJING.longitude}` +
  `&current=relative_humidity_2m&timezone=Asia%2FShanghai`;

/** 上次成功取值的落盘 key。带版本号，字段变了不会读到旧结构 */
const CACHE_KEY = "mumai.weather.beijing-humidity.v1";

/** 第一级就失败、又没有任何缓存时的兜底值（北京秋季常湿，量级正确即可） */
const FALLBACK_HUMIDITY = 58;

/** 重新拉取的间隔。湿度是分钟级变化的量，15 分钟足够，也不至于打爆接口 */
const REFRESH_MS = 15 * 60 * 1000;

/** 超过这个时长就算「缓存」—— 界面按这个口径选择标签，不看请求是否失败 */
const CACHE_STALE_MS = 45 * 60 * 1000;

export type HumiditySource = "live" | "cache" | "fallback";

export type BeijingHumidity = {
  /** 相对湿度（%），三位来源都保证有值 */
  humidity: number;
  source: HumiditySource;
  /** 这个值的取得时刻；缓存与兜底各自是它们自己的时刻 */
  at: number;
  /** 是否正在请求 */
  loading: boolean;
};

type Cache = { humidity: number; at: number; city: string };

function readCache(): Cache | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Cache | null;
    if (!raw || typeof raw.humidity !== "number" || !Number.isFinite(raw.humidity)) return null;
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
    return raw;
  } catch {
    /* 坏 JSON / 隐私模式读不到 —— 当作没有缓存，走兜底 */
    return null;
  }
}

function writeCache(value: number, at: number) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ humidity: value, at, city: "北京市" }));
  } catch {
    /* 写不进去不影响本次显示 */
  }
}

/** 初始值：优先用上次成功取到的值，没有才是兜底常量 */
function initial(): BeijingHumidity {
  const cached = readCache();
  if (cached) return { humidity: cached.humidity, source: "cache", at: cached.at, loading: true };
  return { humidity: FALLBACK_HUMIDITY, source: "fallback", at: Date.now(), loading: true };
}

async function fetchHumidity(signal: AbortSignal): Promise<number> {
  const response = await fetch(HUMIDITY_ENDPOINT, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`湿度接口返回 ${response.status}`);
  const data = (await response.json()) as { current?: { relative_humidity_2m?: unknown } };
  const value = data.current?.relative_humidity_2m;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("湿度接口没有返回读数");
  /* 湿度物理上就在 0–100，超出的值一定不是湿度，宁可不采信 */
  if (value < 0 || value > 100) throw new Error(`湿度接口读数越界：${value}`);
  return Math.round(value);
}

/**
 * 是否允许**真正去公网**取湿度。
 *
 * ── 为什么需要这个开关（工作清单 v1.0 §4.1）──────────────────────────
 * 本文件原本是"现场能上外网就取实时值"的设计，注释里也是这么写的。
 * 但《新剧本纯本地演示-DSH通宵执行工作清单 v1.0》§4 把边界定死了：
 *   「1. 浏览器只允许访问同源地址和 `127.0.0.1` 本机服务，**不得增加公网请求**」
 * 而这是**演示运行时唯一的公网调用点**（`SensorWorkspace` 的"硬件详情"面板用它），
 * 每 15 分钟自动请求一次 `api.open-meteo.com`。断网演示时它会一直失败重试，
 * 且"浏览器网络记录里不得出现公网请求"这条验收会直接不通过。
 *
 * ── 为什么默认关闭是安全的 ──────────────────────────────────────────
 * 本文件的**三级取值**早就为"取不到网"准备好了退路：
 *   live → cache（上次成功值，界面标"缓存"）→ fallback（北京秋季常湿常量，界面标"兜底"）
 * 关掉 live 之后，面板依旧**始终有数字**，只是来源标注从"实时"变成"缓存/兜底"
 * —— 这恰恰是纯本地演示想要的诚实标注，不是功能缺失。
 *
 * 想恢复联网取值的场合：把下面的常量改成 `true`（或在构建时注入）。
 * 但**演示前请确认 §4.1 的要求是否仍然适用**。
 */
const ALLOW_LIVE_FETCH = false;

/**
 * 面板用的钩子。返回值在任何时刻都可用（`humidity` 一定有数字），
 * 断网只会改变 `source`，不会把这一格变成空值。
 *
 * `ALLOW_LIVE_FETCH = false` 时**不发任何网络请求**，直接落到
 * `cache` / `fallback` 两级 —— 见上面常量的说明。
 */
export function useBeijingHumidity(): BeijingHumidity {
  const [state, setState] = useState<BeijingHumidity>(initial);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    let active: AbortController | null = null;

    /*
      离线门：不进 load()、也不起定时器 —— 连"失败重试"都不该发生，
      否则浏览器网络记录里仍会留下一串被拒绝的公网请求（§4.1 验收会判不合格）。
    */
    if (!ALLOW_LIVE_FETCH) {
      setState((prev) => ({ ...prev, loading: false }));
      return () => {
        disposed = true;
      };
    }

    const load = async () => {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      /* 8 秒拿不到就当断网：面板不能让这一格一直转圈等接口 */
      const timeout = window.setTimeout(() => controller.abort(), 8000);
      try {
        const value = await fetchHumidity(controller.signal);
        if (disposed) return;
        const at = Date.now();
        writeCache(value, at);
        setState({ humidity: value, source: "live", at, loading: false });
      } catch {
        if (disposed) return;
        /*
         * 取不到就用上一次的数据。注意这里的 `at` 仍是**上一次成功取值的时刻**：
         * 界面靠它显示「缓存 · 18:20 取得」，不会被刷新成当前时间假装是新的。
         */
        const cached = readCache();
        setState(
          cached
            ? { humidity: cached.humidity, source: "cache", at: cached.at, loading: false }
            : { humidity: FALLBACK_HUMIDITY, source: "fallback", at: Date.now(), loading: false },
        );
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void load();
    timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      active?.abort();
    };
  }, []);

  return state;
}

/**
 * 界面文案：来源 + 状态标签（标签不与「实时」混淆，缓存就是缓存）。
 *
 * `tone` 与其它读数的状态色同一套口径：在线为 ok，缓存与默认值都是
 * 「这个数不是刚测的」，用 warn / muted，不用 ok 假装新鲜。
 */
export function humidityBadge(
  source: HumiditySource,
  at: number,
  now: number,
): { text: string; tone: Tone; stale: boolean } {
  if (source === "live") {
    const late = now - at > CACHE_STALE_MS;
    return { text: late ? "数据延迟" : "实时", tone: late ? "warn" : "ok", stale: false };
  }
  if (source === "cache") return { text: "缓存", tone: "warn", stale: true };
  return { text: "默认值", tone: "muted", stale: true };
}
