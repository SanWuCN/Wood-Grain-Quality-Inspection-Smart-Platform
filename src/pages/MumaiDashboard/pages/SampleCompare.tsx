/**
 * 样本新旧对比 · 照片处理批次（用户 2026-09-22 给的那批素材）
 *
 * ── 用户口径 ──────────────────────────────────────────────────────
 * 「将我现在给的东西呈现到固件及模型，训练验证，新旧对比中」。
 * 给的东西是：1,312 张处理后影像（HEIC 按四宫格切出的单块，1512×2016）、
 * 27 张人工标注原片（3024×4032，编号 IMG_0421–0447）、以及那张
 * 「新文件名 ← 原文件名 ← 源照片 + 位号」的对照表（1,312 行）。
 *
 * 页面把「旧」定义成**原始拍摄件**（`IMG_xxxx.HEIC`，按位号四块拼回原构图），
 * 把「新」定义成**编号件**（`sxs2026092200NNN.jpg`）。包内没附 HEIC 原片，
 * 页面就如实写这一句，不假装手里有。
 *
 * ── 数据从哪来 ────────────────────────────────────────────────────
 *   · 对照表：`/photo-batch-20260922/mapping.csv`（用户原件按字节放进 public，测试里
 *     sha256 钉住）→ `photoSetLogic.parsePhotoMapping` 解析；
 *   · 图片：`/photos/*`（服务端只读映射工作区磁盘上的素材目录，见 photo-set.mjs）；
 *   · 可用性：`GET /api/photo-set`（现读磁盘，素材没挂载时页面给明确提示，不贴碎图）。
 */

import { useEffect, useMemo, useState } from "react";
import NumberAnimation from "@/components/numberAnimation";
import { Panel } from "../Panel";
import { Btn, DataTable, Modal, StatusChip } from "../ui";
import { apiRequest } from "../api/client";
import {
  MAPPING_CSV_URL,
  POSITION_LABEL,
  annotatedOverlap,
  annotatedUrl,
  filterMapping,
  groupBySource,
  pageSlice,
  parsePhotoMapping,
  processedUrl,
  sourceRange,
  summarizePhotoSet,
  type PhotoMappingRow,
  type PhotoSourceGroup,
} from "../photoSetLogic";

/** 血缘表每页行数（1,312 行不可能一次铺开） */
const TABLE_PAGE_SIZE = 12;

type PhotoSetStatus = {
  available: boolean;
  root: string;
  csv: boolean;
  processed: number;
  annotatedCount: number;
  annotated: string[];
  thumbs: boolean;
  expect: { processedDir: string; annotatedDir: string; env: string };
};

/**
 * 一张图：缩略图优先，缺缩略图或加载失败时回落到**原件**。
 *
 * 为什么要有回落：缩略图是派生产物（`缩略图/`，不进 git），素材目录只放了原图时
 * 也应该能看 —— 回落一次比在页面上留一排碎图强。
 */
function PhotoThumb({
  src,
  fallbackSrc,
  alt,
  className,
  onOpen,
  onMeasured,
}: {
  src: string;
  fallbackSrc: string;
  alt: string;
  className?: string;
  onOpen?: () => void;
  onMeasured?: (size: { w: number; h: number }) => void;
}) {
  const [current, setCurrent] = useState(src);
  useEffect(() => setCurrent(src), [src]);
  return (
    <img
      className={className}
      src={current}
      alt={alt}
      loading="lazy"
      onClick={onOpen}
      onError={() => {
        if (current !== fallbackSrc) setCurrent(fallbackSrc);
      }}
      onLoad={(event) => {
        const image = event.currentTarget;
        /* 原件规格由**加载出来的图**实测，不写死在文案里 */
        if (current === fallbackSrc && image.naturalWidth > 0) {
          onMeasured?.({ w: image.naturalWidth, h: image.naturalHeight });
        }
      }}
    />
  );
}

export function SampleComparePanel() {
  const [mapping, setMapping] = useState<{ rows: PhotoMappingRow[]; errors: string[] } | null>(null);
  const [csvFailed, setCsvFailed] = useState(false);
  const [status, setStatus] = useState<PhotoSetStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [lightbox, setLightbox] = useState<{ src: string; title: string; caption: string } | null>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(MAPPING_CSV_URL);
        if (!response.ok) throw new Error(String(response.status));
        const text = await response.text();
        if (alive) setMapping(parsePhotoMapping(text));
      } catch {
        if (alive) setCsvFailed(true);
      }
    })();
    void (async () => {
      try {
        const result = await apiRequest<PhotoSetStatus>("/api/photo-set");
        if (alive) setStatus(result);
      } catch {
        if (alive) setStatusFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* `?? []` 每次渲染都是新数组，会把下面所有 useMemo 的依赖搅得每帧都变 —— 先钉住身份 */
  const rows = useMemo(() => mapping?.rows ?? [], [mapping]);
  const annotated = useMemo(() => status?.annotated ?? [], [status]);
  const groups = useMemo(() => groupBySource(rows), [rows]);
  const summary = useMemo(() => summarizePhotoSet(rows), [rows]);
  const filtered = useMemo(() => filterMapping(rows, query), [rows, query]);
  const table = pageSlice(filtered, page, TABLE_PAGE_SIZE);
  const current: PhotoSourceGroup | undefined = groups[Math.min(sourceIndex, Math.max(0, groups.length - 1))];
  const overlap = useMemo(() => annotatedOverlap(rows, annotated), [rows, annotated]);
  /** 缩略图在不在（服务端现读磁盘）—— 不在就直接用原件 */
  const useThumb = status?.thumbs !== false;

  const step = (delta: number) => {
    if (!groups.length) return;
    setSourceIndex((index) => (index + delta + groups.length) % groups.length);
  };

  const sourceStatus = csvFailed
    ? { tone: "danger" as const, text: "对照表读不到" }
    : statusFailed || status?.available === false
      ? { tone: "warn" as const, text: "素材未挂载" }
      : { tone: "ok" as const, text: `素材已挂载 · ${status?.processed ?? 0} 张` };

  return (
    <>
      <Panel
        title="样本新旧对比 · 照片处理批次"
        icon="biz-data-cleaning"
        extra={<StatusChip text={sourceStatus.text} tone={sourceStatus.tone} />}
        className="fw-panel fw-panel--wide">
        <p className="note">
          这一批是现场照片的处理前 / 处理后对照：处理前是原始拍摄件（按位号切块前的原构图），
          处理后是编号件 <code>sxs20260922NNNNN.jpg</code>。四块按位号摆回原位就是原构图 ——
          包内没有附 HEIC 原片，所以这里不贴「原片」假图，只把四块拼给你看。
        </p>

        {/* 概览：全部由对照表与素材接口推出，不写死 */}
        {/*
          「原图规格」必须是**实测**的：这里挂一张隐藏的原件探针，加载出来就读它的
          naturalWidth/Height。写着 1512×2016 却没人量过，就等于把数字抄进文案里。
        */}
        {rows.length && status?.available ? (
          <img
            className="sc-probe"
            src={processedUrl(rows[0].newName)}
            alt=""
            aria-hidden="true"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0) setMeasured({ w: image.naturalWidth, h: image.naturalHeight });
            }}
          />
        ) : null}
        <ul className="sc-overview">
          <li>
            <small>处理前 · 源照片</small>
            <b>
              <NumberAnimation value={summary.sourceCount} /> 张
            </b>
            <span>{rows.length ? sourceRange(rows) : "—"}</span>
          </li>
          <li>
            <small>处理后 · 编号件</small>
            <b>
              <NumberAnimation value={summary.total} /> 张
            </b>
            <span>
              {summary.sourceCount} 张源照片 × 4 个位号
            </span>
          </li>
          <li>
            <small>已标注原片</small>
            <b>
              <NumberAnimation value={annotated.length} /> 张
            </b>
            <span>IMG_0421–IMG_0447（人工标注）</span>
          </li>
          <li className={measured ? undefined : "is-wait"}>
            <small>原图规格</small>
            <b>{measured ? `${measured.w}×${measured.h}` : "按需实测"}</b>
            <span>由已加载的原件实测</span>
          </li>
        </ul>

        {csvFailed ? (
          <p className="sc-alert">
            对照表读不到（{MAPPING_CSV_URL}）—— 页面上没有编造的行，请检查构建产物里是否有这份 CSV。
          </p>
        ) : null}

        {statusFailed || status?.available === false ? (
          <p className="sc-alert">
            素材目录未挂载：把「处理」包解压到 <code>{status?.expect.processedDir ?? "D:\\平台\\数据集-照片处理-20260922\\处理完毕"}</code>
            （或设环境变量 <code>{status?.expect.env ?? "MUMAI_PHOTO_DIR"}</code>）后刷新 —— 对照表与行数照常可查，图不会贴成碎图。
          </p>
        ) : null}

        {mapping && mapping.errors.length > 0 ? (
          <p className="sc-alert">
            对照表有 <NumberAnimation value={mapping.errors.length} /> 行没读出来（字段不齐或位号不合法），
            它们没有进下面任何统计：{mapping.errors.slice(0, 3).join("；")}
          </p>
        ) : null}

        {/* ── 四宫格：按位号把四块摆回原构图 ───────────────────────── */}
        <section className="sc-block" aria-label="四宫格拼回原构图">
          <header>
            <b>四宫格拼回原构图</b>
            <div className="sc-picker">
              <Btn onClick={() => step(-1)} disabled={!groups.length} title="上一张源照片">
                上一张
              </Btn>
              <select
                aria-label="选择源照片"
                value={current?.source ?? ""}
                onChange={(event) => {
                  const index = groups.findIndex((group) => group.source === event.target.value);
                  if (index >= 0) setSourceIndex(index);
                }}>
                {groups.map((group) => (
                  <option key={group.source} value={group.source}>
                    {group.source}
                  </option>
                ))}
              </select>
              <Btn onClick={() => step(1)} disabled={!groups.length} title="下一张源照片">
                下一张
              </Btn>
              <span className="muted">
                第 <NumberAnimation value={groups.length ? sourceIndex + 1 : 0} group={false} /> /{" "}
                <NumberAnimation value={groups.length} group={false} /> 张
              </span>
            </div>
          </header>

          {current ? (
            <>
              {/* 左边四宫格（拼回原构图），右边这张原片的四块对照表 —— 一行一行核得上 */}
              <div className="sc-quad">
                <div className="sc-grid">
                  {current.crops.map((crop) => (
                    <figure key={crop.newName} className={`sc-cell sc-cell--pos${crop.pos}`}>
                      <PhotoThumb
                        className="sc-cell__img"
                        src={processedUrl(crop.newName, { thumb: useThumb })}
                        fallbackSrc={processedUrl(crop.newName)}
                        alt={`${crop.newName}（${crop.oldName}，位号 ${crop.pos}）`}
                        onMeasured={setMeasured}
                        onOpen={() =>
                          setLightbox({
                            src: processedUrl(crop.newName),
                            title: crop.newName,
                            caption: `${crop.source} · 位号 ${crop.pos}（${POSITION_LABEL[crop.pos]}）· 原文件名 ${crop.oldName}`,
                          })
                        }
                      />
                      <figcaption>
                        <b>位号 {crop.pos}</b>
                        <span>{crop.oldName}</span>
                        <code>{crop.newName}</code>
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <div className="sc-quad__side">
                  <DataTable
                    compact
                    head={["位号", "原文件名", "新编号"]}
                    rows={current.crops.map((crop) => [
                      `位号 ${crop.pos}（${POSITION_LABEL[crop.pos]}）`,
                      crop.oldName,
                      <b key={`c-${crop.newName}`}>{crop.newName}</b>,
                    ])}
                  />
                  <p className="note">
                    源照片 <code>{current.source}</code> 按四宫格切成四块：
                    位号 1/2/3/4 = 左上/右上/左下/右下。编号顺序与位号「无关」
                    （同一张原片的四块编号是跳的），所以摆位必须照位号 ——
                    四块拼起来就是这张原片的构图。点任一格看原件（1512×2016）。
                  </p>
                </div>
              </div>
            </>
          ) : (
            <p className="muted">对照表还没有读进来。</p>
          )}
        </section>

        {/* ── 编号对照（血缘）：搜索 + 分页，1,312 行不糊成一团 ────── */}
        <section className="sc-block" aria-label="新文件名与原文件名对照">
          <header>
            <b>编号对照（新文件名 ← 原文件名）</b>
            <div className="sc-picker">
              <input
                type="search"
                value={query}
                placeholder="搜新编号 / 原文件名 / 源照片，如 IMG_0766"
                aria-label="搜索对照表"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
              <Btn onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={table.page <= 1}>
                上一页
              </Btn>
              <span className="muted">
                第 <NumberAnimation value={table.page} group={false} /> /{" "}
                <NumberAnimation value={table.pages} group={false} /> 页
              </span>
              <Btn onClick={() => setPage((value) => Math.min(table.pages, value + 1))} disabled={table.page >= table.pages}>
                下一页
              </Btn>
            </div>
          </header>
          <DataTable
            compact
            head={["新文件名", "原文件名", "源照片", "位号"]}
            rows={table.items.map((row) => [
              <b key={`n-${row.newName}`}>{row.newName}</b>,
              row.oldName,
              row.source,
              `位号 ${row.pos}（${POSITION_LABEL[row.pos]}）`,
            ])}
          />
          <p className="note">
            {/* 四位数的计数带千分位（与平台其它地方一致）：共 1,312 行 */}
            共 <NumberAnimation value={table.total} /> 行
            {query.trim() ? `（关键词「${query.trim()}」筛出来的）` : ""} ·
            位号分布 {summary.byPosition.map((item) => `${item.pos}${item.label} ${item.count}`).join(" · ")} ·
            <a href={MAPPING_CSV_URL} target="_blank" rel="noreferrer">
              打开对照表原件
            </a>
            {summary.incomplete.length ? ` · ⚠ ${summary.incomplete.length} 张源照片四块不齐` : " · 每张源照片四块齐全"}
          </p>
        </section>

        {/* ── 已标注原片：与对照表没有交集，单独成组 ───────────────── */}
        {annotated.length > 0 ? (
          <section className="sc-block" aria-label="已标注原片">
            <header>
              <b>已标注原片（人工标注）</b>
              <span className="muted">
                <NumberAnimation value={annotated.length} /> 张 ·{" "}
                {overlap.length
                  ? `其中 ${overlap.length} 张与对照表的源照片同号`
                  : "与对照表的源照片没有交集，单独成组（不硬配对）"}
              </span>
            </header>
            <ul className="sc-wall">
              {annotated.map((name) => (
                <li key={name}>
                  <PhotoThumb
                    className="sc-wall__img"
                    src={annotatedUrl(name, { thumb: useThumb })}
                    fallbackSrc={annotatedUrl(name)}
                    alt={`已标注原片 ${name}`}
                    onMeasured={setMeasured}
                    onOpen={() =>
                      setLightbox({ src: annotatedUrl(name), title: name, caption: "已标注原片（人工标注，3024×4032 原尺寸）" })
                    }
                  />
                  <span>{name}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="note">
          素材落在工作区磁盘上（<code>{status?.root ?? "—"}</code>），由平台服务按{" "}
          <code>/photos/processed/…</code>、<code>/photos/annotated/…</code> 只读映射 ——
          所以内网别的机器打开这一页也能看图，不需要把 400 多 MB 塞进前端构建。
        </p>
      </Panel>

      {lightbox ? (
        <Modal
          wide
          title={lightbox.title}
          subtitle={<span>{lightbox.caption}</span>}
          onClose={() => setLightbox(null)}
          footer={<Btn onClick={() => setLightbox(null)}>关闭</Btn>}>
          <img className="sc-lightbox__img" src={lightbox.src} alt={lightbox.title} />
        </Modal>
      ) : null}
    </>
  );
}

export default SampleComparePanel;
