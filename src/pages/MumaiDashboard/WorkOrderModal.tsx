import type { WorkOrder } from "./data";
import { Icon } from "./icons";

export default function WorkOrderModal({ order, onClose }: { order: WorkOrder; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <article className="order-modal" role="dialog" aria-modal="true" aria-labelledby="order-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>复核工单</span><h2 id="order-title">{order.id}</h2></div><button onClick={onClose} aria-label="关闭工单"><Icon name="close"/></button></header>
      <div className="order-modal__summary">
        <div><small>点位</small><strong>{order.district} · {order.site}</strong></div><div><small>构件</small><strong>{order.component} 下部</strong></div><div><small>风险等级</small><strong className="danger">{order.level}</strong></div><div><small>当前状态</small><strong className="warning">{order.status}</strong></div>
      </div>
      <div className="evidence-grid">
        <section><h3>融合证据</h3><div className="scan-visual"><span className="scan-visual__hotspot"/><i/><i/><i/></div><p>图像标注与雷达响应均指向同一测区，规则版本 FUSION-03 判定为优先复核。</p></section>
        <section><h3>检测结果</h3><div className="wave"><svg viewBox="0 0 320 110"><path d="M0 63 C22 18 38 98 58 55 S90 34 110 62 S145 84 160 48 S188 8 205 56 S238 104 254 54 S290 21 320 61"/><line x1="205" x2="205" y1="8" y2="104"/></svg></div><dl><div><dt>异常类型</dt><dd>{order.finding}</dd></div><div><dt>模型响应</dt><dd>{order.score ?? "待复核"}</dd></div><div><dt>数据来源</dt><dd>replay · 已归档</dd></div></dl></section>
      </div>
      <ol className="timeline"><li className="done"><span/>初扫触发异常<time>09:42</time></li><li className="done"><span/>复扫与融合完成<time>10:18</time></li><li className="active"><span/>等待专业复核<time>当前</time></li><li><span/>施工反馈与验收<time>待安排</time></li></ol>
      <footer><button className="button button--ghost" onClick={onClose}>返回态势地图</button><button className="button button--primary" onClick={onClose}>确认并进入待复核</button></footer>
    </article>
  </div>;
}
