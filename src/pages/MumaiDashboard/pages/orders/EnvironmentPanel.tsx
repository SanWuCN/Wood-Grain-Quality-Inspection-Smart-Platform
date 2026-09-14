/**
 * 环境记录与配置校验（PRD-工单指派与扫描仪下发-v1.0 §5.1 第 4 项 / §7）
 *
 * 一级页面只放**当前读数摘要**与校验结论，表单全部下沉到「录入读数」弹窗 ——
 * 不为一次录入在一级页面上铺开一张表单。
 *
 * 几条不能让步的口径：
 *   · 空值显示「—」+「待录入」，**不显示 0、26.4、78、1.2 这类默认值**（A09）。
 *   · 空字符串先判空再转换，不做 `Number("")`（A10）；非有限数同样当没填。
 *   · 气压允许按 hPa / kPa / Pa 录入，但本组件**不做换算**：原始值与单位一起交给
 *     服务端，由服务端换算后统一存 hPa（§7.1），避免前端把 kPa 当 hPa 存下来。
 *   · 校验通过只代表「可以下发」，不代表扫描仪已经收到（§7.3.4）—— 这条不进页面文案，
 *     界面上不写「已下发 / 已接收」这类结论。
 *
 * 页面文案只留「标签 + 值 + 按钮 + 状态」：解释性小字不进 UI，空态只留一行标题
 * （StateBlock 不给 hint 会掉进 ui.tsx 的兜底解释句，所以显式传空串）。
 * 仪表不再由录入人选择（服务端已支持不挂仪表校验），因此弹窗里只有四项读数 +
 * 气压单位 + 测量信息。
 */

import { useState } from "react";
import { Panel } from "../../Panel";
import { Icon } from "../../icons";
import { Btn, KV, Modal, StateBlock, StatusChip } from "../../ui";
import type { EnvironmentFieldKey, EnvironmentView, WorkOrderDetail } from "../../api/client";
import "./orders.css";

/** 保存草稿的提交体：与服务端 `PUT /api/work-orders/:id/environment-draft` 一一对应 */
type EnvironmentBody = {
  inputs: Partial<Record<"airTempC" | "relativeHumidityPct" | "windSpeedMs" | "atmosphericPressureHpa", number | null>>;
  pressure: { value: number | null; unit: string } | null;
  instruments: { instrumentId: string; fields: string[]; source?: string }[];
  position: string;
  measuredAt: string;
  expectedRevision: number;
};

/** 服务端 `ENV_FIELDS` 的兜底副本：接口没给字典时仍能显示中文名与单位 */
const FALLBACK_FIELDS: Record<EnvironmentFieldKey, { key: EnvironmentFieldKey; label: string; unit: string }> = {
  airTempC: { key: "airTempC", label: "温度", unit: "℃" },
  relativeHumidityPct: { key: "relativeHumidityPct", label: "相对湿度", unit: "%RH" },
  windSpeedMs: { key: "windSpeedMs", label: "风速", unit: "m/s" },
  atmosphericPressureHpa: { key: "atmosphericPressureHpa", label: "大气压", unit: "hPa" },
};

/** 气压允许显式选择的单位；换算由服务端完成（PRD §7.1：1 hPa = 100 Pa，1 kPa = 10 hPa） */
const PRESSURE_UNITS = ["hPa", "kPa", "Pa"];

function fieldOf(fields: EnvironmentView["fields"], key: EnvironmentFieldKey) {
  return fields.find((item) => item.key === key) ?? FALLBACK_FIELDS[key];
}

/** 有限数才当读数；null / undefined / NaN / Infinity 一律算「没填」 */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 输入框文本 → 数值：空串与纯空白是 null，绝不当 0；非有限数同样给 null */
function toNumberOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 数值 → 输入框文本：没填就是空输入框，不是 "0" */
function toInputText(value: number | null | undefined): string {
  const numeric = finiteOrNull(value);
  return numeric === null ? "" : String(numeric);
}

/**
 * ISO 时间 → `datetime-local` 需要的 `YYYY-MM-DDTHH:mm`。
 *
 * 带时区的串按字面取墙钟（`2026-09-14T09:40:00+08:00` → `2026-09-14T09:40`）：
 * 录入人写的就是现场墙钟时间，不做浏览器时区换算，免得测量时间被平移。
 */
function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const matched = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(value);
  if (matched) return matched[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function EnvironmentPanel({
  detail,
  busy,
  onSave,
  onValidate,
}: {
  detail: WorkOrderDetail;
  busy: boolean;
  onSave: (body: EnvironmentBody) => Promise<void>;
  onValidate: (expectedRevision: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const env = detail.environment;
  const config = env.config;
  const fields = env.fields.length ? env.fields : Object.values(FALLBACK_FIELDS);
  const canEdit = detail.capabilities.canEditEnvironment;
  const canValidate = detail.capabilities.canValidate;

  /** 气压原值：只有单位不是 hPa 时才额外标出来，让「记录与追溯」看得到原始录入 */
  const rawPressure =
    env.pressureInput &&
    Number.isFinite(env.pressureInput.value) &&
    env.pressureInput.unit.trim().toLowerCase() !== "hpa"
      ? `原值 ${env.pressureInput.value} ${env.pressureInput.unit}`
      : null;

  const runValidate = async () => {
    try {
      await onValidate(env.draftRevision);
    } catch {
      // 错误由父组件显示在别处；这里只保证不留下未处理的 rejection
    }
  };

  return (
    <Panel
      title="环境记录与配置校验"
      icon="biz-multimodal"
      extra={
        env.needsRevalidate ? (
          <StatusChip text="需重新校验" tone="warn" />
        ) : config ? (
          <StatusChip text={`已生成 ${config.configVersion}`} tone="ok" />
        ) : (
          <StatusChip text="未生成配置版本" tone="muted" />
        )
      }>
      {/* 一级页面只显示当前读数摘要：没录入就是「—」+「待录入」，不显示任何演示默认值 */}
      <ul className="wo-readings">
        {fields.map((field) => {
          const value = finiteOrNull(env.inputs[field.key]);
          const invalidPressure = field.key === "atmosphericPressureHpa" && env.pressureInput?.invalid === true;
          return (
            <li key={field.key} className={value === null ? "wo-reading is-pending" : "wo-reading"}>
              <small>{field.label}</small>
              <b>
                {value === null ? "—" : value}
                <em>{field.unit}</em>
              </b>
              {value === null ? <StatusChip text="待录入" tone="muted" /> : null}
              {rawPressure && field.key === "atmosphericPressureHpa" ? (
                <span className="wo-reading__raw">{rawPressure}</span>
              ) : null}
              {invalidPressure ? <StatusChip text="气压原值无法换算" tone="warn" /> : null}
            </li>
          );
        })}
      </ul>

      <KV
        columns={3}
        items={[
          { k: "测量位置", v: env.position ?? "—" },
          { k: "测量时间", v: env.measuredAt ?? "—" },
          { k: "录入人岗位", v: env.updatedByLabel ?? "—" },
          { k: "配置版本", v: config?.configVersion ?? "—" },
          { k: "草稿版本", v: `rev ${env.draftRevision}` },
          { k: "最近保存", v: env.updatedAt ?? "—" },
        ]}
      />

      <div className="wo-actions">
        <Btn
          disabled={!canEdit || busy}
          title={
            canEdit
              ? "录入四项读数与测量信息"
              : detail.capabilities.assigned
                ? "你在本单没有「环境录入」职责"
                : "尚未指派到此工单"
          }
          onClick={() => setOpen(true)}>
          录入读数
        </Btn>
        {/* PRD §6.2：本期只有项目经理能运行校验并生成配置版本 */}
        <Btn
          tone="primary"
          disabled={!canValidate || busy}
          title={canValidate ? "运行校验并生成配置版本" : "只有项目经理可以运行校验"}
          onClick={() => void runValidate()}>
          运行校验
        </Btn>
      </div>

      <h4 className="sub">
        配置版本与校验结论
        {config?.superseded ? <StatusChip text="已被新版本取代" tone="warn" /> : null}
      </h4>
      {config ? (
        <KV
          columns={4}
          items={[
            { k: "版本号", v: config.configVersion },
            { k: "校验时间", v: config.validatedAt },
            { k: "校验人岗位", v: config.validatedByLabel },
            { k: "方法版本", v: config.methodVersion },
          ]}
        />
      ) : (
        <StateBlock kind="empty" title="尚未生成配置版本" hint="" />
      )}
      {config ? (
        <ul className="wo-checks">
          {config.checks.map((check) => (
            <li key={check.key} className={check.ok ? "is-ok" : "is-bad"}>
              {/* 校验结论是完成 / 告警语义：用 status-success / status-warning，不用审核入口的日历勾 */}
              <Icon
                name={check.ok ? "status-success" : "status-warning"}
                size={16}
                tone={check.ok ? "success" : "warning"}
                aria-hidden
              />
              {check.label}
              <em>{check.message}</em>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? <EnvDraftModal env={env} busy={busy} onSave={onSave} onClose={() => setOpen(false)} /> : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 录入读数弹窗（二级）：四项读数 + 气压单位 + 测量信息
 *
 * 打开时挂载，初值直接取当前草稿（新单就是空输入框），不在 effect 里回填，
 * 免得用户正在填的时候被一次刷新冲掉。
 *
 * 仪表不由录入人选择：`instruments` 固定提交空数组，量程由服务端按缺省量程判定。
 * ------------------------------------------------------------------ */

function EnvDraftModal({
  env,
  busy,
  onSave,
  onClose,
}: {
  env: EnvironmentView;
  busy: boolean;
  onSave: (body: EnvironmentBody) => Promise<void>;
  onClose: () => void;
}) {
  const fields = env.fields.length ? env.fields : Object.values(FALLBACK_FIELDS);

  const [values, setValues] = useState<Record<EnvironmentFieldKey, string>>(() => ({
    airTempC: toInputText(env.inputs.airTempC),
    relativeHumidityPct: toInputText(env.inputs.relativeHumidityPct),
    windSpeedMs: toInputText(env.inputs.windSpeedMs),
    // 气压优先回填**原始录入值**（保留单位），没有原始记录时才退回换算后的 hPa
    atmosphericPressureHpa: env.pressureInput
      ? String(env.pressureInput.value)
      : toInputText(env.inputs.atmosphericPressureHpa),
  }));
  const [pressureUnit, setPressureUnit] = useState(
    PRESSURE_UNITS.find((unit) => unit.toLowerCase() === (env.pressureInput?.unit ?? "").trim().toLowerCase()) ?? "hPa",
  );
  const [position, setPosition] = useState(env.position ?? "");
  const [measuredAt, setMeasuredAt] = useState(() => toLocalInput(env.measuredAt));
  const [saving, setSaving] = useState(false);

  const pending = busy || saving;

  const save = async () => {
    const pressureValue = toNumberOrNull(values.atmosphericPressureHpa);
    const unit = pressureUnit.trim();
    setSaving(true);
    try {
      await onSave({
        /*
          大气压不写进 `inputs.atmosphericPressureHpa`：那个字段是换算后的 hPa。
          原始值 + 单位走 `pressure`，换算由服务端完成（PRD §7.1）。
        */
        inputs: {
          airTempC: toNumberOrNull(values.airTempC),
          relativeHumidityPct: toNumberOrNull(values.relativeHumidityPct),
          windSpeedMs: toNumberOrNull(values.windSpeedMs),
          atmosphericPressureHpa: null,
        },
        pressure: pressureValue === null || unit === "" ? null : { value: pressureValue, unit },
        // 不挂仪表：服务端按缺省量程校验
        instruments: [],
        position: position.trim(),
        measuredAt,
        expectedRevision: env.draftRevision,
      });
    } catch {
      // 错误由父组件显示在别处；保持弹窗打开，已填内容不丢
      setSaving(false);
      return;
    }
    onClose();
  };

  const numberField = (key: EnvironmentFieldKey) => {
    const field = fieldOf(fields, key);
    return (
      <div className="wo-form__item" key={key}>
        <span>
          {field.label}（{field.unit}）
        </span>
        <div className="wo-form__pair">
          <input
            className="wo-input"
            type="number"
            inputMode="decimal"
            value={values[key]}
            disabled={pending}
            aria-label={`${field.label}读数`}
            onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
          />
        </div>
      </div>
    );
  };

  return (
    <Modal
      wide
      title="录入环境读数"
      onClose={onClose}
      footer={
        <Btn tone="primary" disabled={pending} onClick={() => void save()}>
          保存草稿
        </Btn>
      }>
      <h4 className="sub">四项读数</h4>
      <div className="wo-form">
        {numberField("airTempC")}
        {numberField("relativeHumidityPct")}
        {numberField("windSpeedMs")}
        {/* 大气压多一个显式单位：换算由服务端做，原始值与单位一起留档 */}
        <div className="wo-form__item">
          <span>{fieldOf(fields, "atmosphericPressureHpa").label}</span>
          <div className="wo-form__pair">
            <input
              className="wo-input"
              type="number"
              inputMode="decimal"
              value={values.atmosphericPressureHpa}
              disabled={pending}
              aria-label="大气压读数"
              onChange={(event) =>
                setValues((current) => ({ ...current, atmosphericPressureHpa: event.target.value }))
              }
            />
            <select
              className="wo-select wo-select--unit"
              value={pressureUnit}
              disabled={pending}
              aria-label="大气压单位"
              onChange={(event) => setPressureUnit(event.target.value)}>
              {PRESSURE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="wo-form__item wo-form__full">
          <span>测量位置</span>
          <input
            className="wo-input"
            value={position}
            disabled={pending}
            aria-label="测量位置"
            onChange={(event) => setPosition(event.target.value)}
          />
        </div>
        <div className="wo-form__item wo-form__full">
          <span>测量时间</span>
          <input
            className="wo-input"
            type="datetime-local"
            value={measuredAt}
            disabled={pending}
            aria-label="测量时间"
            onChange={(event) => setMeasuredAt(event.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
