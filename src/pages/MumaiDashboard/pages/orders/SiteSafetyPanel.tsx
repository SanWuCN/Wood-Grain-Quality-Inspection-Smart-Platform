import { Panel } from "../../Panel";
import { SourceTag, StatusChip } from "../../ui";
import { getSiteSafetyRecord } from "./siteSafety";
import "./task-scope.css";

export function SiteSafetyPanel({ orderId, className = "" }: { orderId: string; className?: string }) {
  const record = getSiteSafetyRecord(orderId);
  if (!record) return null;

  return (
    <Panel
      title="现场安全登记"
      className={`site-safety ${className}`.trim()}
      extra={<StatusChip text={record.status} tone={record.statusTone} dot />}>
      <dl className="site-safety__locations">
        {record.locations.map((item) => (
          <div key={item.key} className={item.value ? "" : "is-pending"}>
            <dt>{item.label}</dt>
            <dd>
              <b>{item.value ?? item.state}</b>
              <span>{item.note}</span>
            </dd>
            <StatusChip text={item.state} tone={item.value ? "ok" : "warn"} />
          </div>
        ))}
      </dl>
      <footer className="site-safety__meta">
        <span>更新时间 · {record.updatedAt}</span>
        <span>通知状态 · {record.notification}</span>
        <SourceTag label={record.source} />
      </footer>
    </Panel>
  );
}
