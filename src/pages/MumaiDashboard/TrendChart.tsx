/**
 * 总览页的两张自绘小图（不引入 ECharts 实例）
 *
 * 规范 §5.1：默认数据主系列只用 BLUE(#4EA8FF) / CYAN(#5DE4FF)，
 * 网格 rgba(130,180,230,.08)，坐标轴文字 #647990；
 * 颜色一律引用 design.ts 的 CHART / COLORS，组件里不写死色值。
 */

import { CHART, COLORS } from "./design";

const values = [6, 9, 12, 18, 24, 18];
const months = ["4月", "5月", "6月", "7月", "8月", "9月"];

export function TrendChart() {
  const points = values.map((value, index) => `${18 + index * 47},${111 - value * 3.25}`).join(" ");
  return <div className="trend-chart">
    <svg viewBox="0 0 276 142" role="img" aria-label="近六月巡检趋势折线图">
      <defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={CHART.palette[0]} stopOpacity=".32"/><stop offset="1" stopColor={CHART.palette[0]} stopOpacity="0"/></linearGradient></defs>
      {[0, 1, 2, 3].map((line) => <line key={line} x1="14" x2="264" y1={28 + line * 28} y2={28 + line * 28} stroke={CHART.grid} strokeDasharray="3 4"/>)}
      <path d={`M ${points} L 253 122 L 18 122 Z`} fill="url(#trendFill)"/>
      <polyline points={points} fill="none" stroke={CHART.palette[0]} strokeWidth="2"/>
      {values.map((value, index) => <g key={value + index}><circle cx={18 + index * 47} cy={111 - value * 3.25} r="3" fill={COLORS.textPrimary} stroke={CHART.palette[0]} strokeWidth="2"/><text x={18 + index * 47} y={101 - value * 3.25} textAnchor="middle">{value}</text><text x={18 + index * 47} y="138" textAnchor="middle" className="axis">{months[index]}</text></g>)}
    </svg>
  </div>;
}

export function DistrictBars() {
  const rows = [["松江区", 2], ["嘉定区", 1], ["青浦区", 1], ["浦东新区", 1], ["黄浦区", 1]] as const;
  return <div className="district-bars">{rows.map(([name, value]) => <div className="district-bar" key={name}><span>{name}</span><i><b style={{ width: `${value * 46}%` }}/></i><em>{value}</em></div>)}</div>;
}
