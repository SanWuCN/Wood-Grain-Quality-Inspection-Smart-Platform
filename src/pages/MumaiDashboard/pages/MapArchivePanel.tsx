/**
 * 「最近一次成功建图（归档）」面板 —— 车离线时建图页的那一屏
 *
 * 数据全部来自 `mapArchive.ts`（它只读 `MAP_VERSIONS` / `GRID_MAP` / `ARCHIVE_ITEMS`）。
 * 画法：`GRID_MAP.cells` 按 `GRID_MAP.legend` 的配色画成缩略栅格图（40×26），
 * 配色**只有一份来源**（legend），界面不另写颜色表。
 */

import { useEffect, useRef } from "react";

import { Panel } from "../Panel";
import { SourceTag } from "../ui";
import { archivedMapPanel } from "./mapArchive";
import "./mapArchive.css";

export type MapArchivePanelProps = {
  /** 当前有没有实时地图 */
  hasLiveMap: boolean;
  /** 平台到小车这条链路的状态 */
  link?: string;
};

export function MapArchivePanel({ hasLiveMap, link }: MapArchivePanelProps) {
  const model = archivedMapPanel({ hasLiveMap, link });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) return;
    const { grid } = model;
    const scale = 8; /* 一格 8 px：40×26 → 320×208 */
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = grid.width * scale * dpr;
    canvas.height = grid.height * scale * dpr;
    canvas.style.width = `${grid.width * scale}px`;
    canvas.style.height = `${grid.height * scale}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const color = new Map(grid.legend.map((item) => [item.code, item.color]));
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        ctx.fillStyle = color.get(grid.cells[y * grid.width + x]) ?? "#0a1526";
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    /* 给探针一个可断言的读数：画了多少格、用的哪份版本 */
    canvas.dataset.cells = String(grid.cells.length);
    canvas.dataset.version = model.version.id;
  }, [model]);

  if (!model) return null;
  const { version, grid, assets } = model;

  return (
    <Panel
      title="最近一次成功建图（归档）"
      extra={<SourceTag label="归档快照 · 不是实时画面" />}
      className="map-archive">
      <div className="map-archive__body">
        <div className="map-archive__grid">
          <canvas ref={canvasRef} data-testid="map-archive-canvas" aria-label="归档栅格地图缩略图" />
          <ul className="map-archive__legend">
            {grid.legend.map((item) => (
              <li key={item.code}>
                <i style={{ background: item.color }} />
                {item.label}
              </li>
            ))}
          </ul>
        </div>
        <div className="map-archive__meta">
          <p className="map-archive__headline">{model.headline}</p>
          <dl>
            <div>
              <dt>建图版本</dt>
              <dd>
                {version.id} · {version.state} · 覆盖 {version.coveragePct}% · {version.resolutionM} m/格
              </dd>
            </div>
            <div>
              <dt>建图时间</dt>
              <dd>{version.updatedAt}</dd>
            </div>
            <div>
              <dt>栅格尺寸</dt>
              <dd>
                {grid.width} × {grid.height} 格 · 原点 [{grid.origin[0]}, {grid.origin[1]}] ·{" "}
                {grid.resolutionM} m/格
              </dd>
            </div>
            <div>
              <dt>归档文件</dt>
              <dd>
                {assets.map((asset) => (
                  <span key={asset.name} className="map-archive__asset">
                    {asset.name}（{asset.sizeText}）
                    <b className={asset.sha256Match ? "is-ok" : "is-bad"}>
                      {asset.sha256Match ? "SHA-256 一致" : "SHA-256 不一致"}
                    </b>
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt>本轮说明</dt>
              <dd>{version.note}</dd>
            </div>
          </dl>
          <p className="map-archive__caption">{model.caption}</p>
          <ol className="map-archive__recovery">
            {model.recovery.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
    </Panel>
  );
}
