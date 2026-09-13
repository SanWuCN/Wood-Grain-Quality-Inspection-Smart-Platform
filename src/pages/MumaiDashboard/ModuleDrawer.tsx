import { moduleCopy } from "./data";
import { Icon } from "./icons";

export default function ModuleDrawer({ name, onClose, onOpenOrder }: { name: string; onClose: () => void; onOpenOrder: () => void }) {
  const copy = moduleCopy[name];
  if (!copy) return null;
  return <aside className="module-drawer" aria-live="polite">
    <header><span>业务模块</span><button type="button" className="mumai-icon-button" onClick={onClose} aria-label="关闭模块概览"><Icon name="action-close" size={16} aria-hidden/></button></header>
    <h2>{copy.title}</h2><p>{copy.summary}</p>
    <div className="module-drawer__steps">{copy.steps.map((step, index) => <div key={step}><i>{String(index + 1).padStart(2, "0")}</i><span>{step}</span><b>{index < 2 ? "已就绪" : "当前"}</b></div>)}</div>
    <button className="button button--primary" onClick={name === "工单档案" ? onOpenOrder : onClose}>{copy.action}<Icon name="arrow" size={20} aria-hidden/></button>
  </aside>;
}
