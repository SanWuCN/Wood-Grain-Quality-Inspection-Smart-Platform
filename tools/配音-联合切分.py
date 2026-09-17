#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
联合切分：枚举 4 个切点，使"第 k 段 ↔ 第 k 条目标句"的 2-gram 命中率之和最大。

── 为什么是"联合"而不是"逐条锚定" ──────────────────────────────────
逐条找"最匹配的片段"必然过拟合：某条目标句的 2-gram 集合是另一条的子集时，
它会把范围撑到把别的句子也包进去（实测 ② 被锚到 14.20–48.60s，里面含 ④、段15、②）。
加一条**结构约束**就解决了：五段必须**顺序一一对应**五条目标句，不许重叠、不许乱序。
目标是"五段整体最像"，而不是"某一段最像"。

候选切点取**静音的起点**（含句内停顿）——这里不需要判"哪处静音才是句界"，
只让优化去选；句内停顿当切点会立刻降低相邻两段的命中率，被目标函数自然排除。

用法：python 联合切分.py --in <合并.mp3> --out <目录>
"""
import argparse
import json
import os
import subprocess
import sys

TARGETS = [
    ("round-01", "①", "已整理为四项任务：现场建档、风险初筛、重点精扫和复核交付。附件里未明确的信息，我已单独列出。本次任务涉及的木构主体为四根木柱。我已按照Z01至Z04编号。"),
    ("round-04", "④", "收到，我来核对范围，本次完成巡检和辅助诊断，形成可追溯记录。"),
    ("seg-15", "④", "收到，已启用同步备份"),
    ("round-02", "②", "已按工单地点建立天气查询，累计降雨412.0毫米、降雨37天、平均相对湿度78%、最大阵风17.8米每秒。建议优先检查柱脚返潮、屋面排水、漆层起翘和迎风面连接，现场结论以实测为准。"),
    ("round-03", "③", "工单任务已同步到工作台，四项任务进入现场建档阶段。环境配置、地图、场景和检测批次将关联本次工单，交接时可直接查看上一岗位提交的结果。"),
]


def clean(s):
    return "".join(ch for ch in s if ch.isalnum())


def grams(s, n=2):
    s = clean(s)
    return {s[i:i + n] for i in range(len(s) - n + 1)} or {s}


def hit(target_g, text):
    return len(target_g & grams(text)) / max(1, len(target_g))


def silence_starts(src, noise="-35dB", d=0.25):
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", src, "-af", f"silencedetect=noise={noise}:d={d}", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    starts = []
    for line in r.stderr.splitlines():
        if "silence_start:" in line:
            starts.append(float(line.split("silence_start:")[1].split()[0]))
    return sorted(starts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--model", default=r"D:\平台\voice-module\model\small")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    segments, info = model.transcribe(args.src, language="zh", beam_size=5)
    segs = [{"t": s.text.strip(), "s": round(s.start, 3), "e": round(s.end, 3)} for s in segments]
    total = info.duration
    print(f"ASR 片段 {len(segs)} 个，总时长 {total:.2f}s")

    cands = silence_starts(args.src)
    # 只保留"离首尾足够远、且彼此至少差 1s"的候选，缩小搜索并避免切出空段
    cands = [c for c in cands if 3.0 < c < total - 3.0]
    filtered = []
    for c in cands:
        if not filtered or c - filtered[-1] >= 1.0:
            filtered.append(c)
    print(f"候选切点 {len(filtered)} 个：{ [round(c,2) for c in filtered] }")

    # 预计算：任意区间 [a,b) 的 ASR 文本
    def text_of(a, b):
        return "".join(s["t"] for s in segs if s["s"] >= a - 0.35 and s["e"] <= b + 0.35)

    tg = [grams(t[2]) for t in TARGETS]
    best = None
    n = len(filtered)
    for i in range(n - 3):
        for j in range(i + 1, n - 2):
            for k in range(j + 1, n - 1):
                for l in range(k + 1, n):
                    cuts = [filtered[i], filtered[j], filtered[k], filtered[l]]
                    bounds = [0.0, *cuts, total]
                    spans = [(bounds[m], bounds[m + 1]) for m in range(5)]
                    score = sum(hit(tg[m], text_of(*spans[m])) for m in range(5))
                    if best is None or score > best[0]:
                        best = (score, cuts, [round(hit(tg[m], text_of(*spans[m])), 3) for m in range(5)])

    score, cuts, per = best
    print(f"\n最优切点：{cuts}")
    print(f"五段命中率之和 {score:.3f}　逐段：{per}")

    bounds = [0.0, *cuts, total]
    parts = []
    for m in range(5):
        out = os.path.join(args.out, f"p{m + 1}.mp3")
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", args.src,
               "-ss", str(bounds[m]), "-to", str(bounds[m + 1]),
               "-c:a", "libmp3lame", "-q:a", "4", out]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise SystemExit(f"第 {m + 1} 段切失败：{r.stderr[:200]}")
        parts.append(out)

    print("\n逐段独立转写复核（重新转写，不复用区间文本）：")
    rows = []
    for m, f in enumerate(parts):
        sg, _ = model.transcribe(f, language="zh", beam_size=5)
        text = "".join(s.text for s in sg).strip()
        h = hit(tg[m], text)
        rows.append({"part": os.path.basename(f), "want": TARGETS[m][0], "round": TARGETS[m][1],
                     "start": bounds[m], "end": bounds[m + 1], "hit": round(h, 3),
                     "target": TARGETS[m][2], "asr": text})
        print(f"\n  【{os.path.basename(f)}】{bounds[m]:.2f}–{bounds[m+1]:.2f}s → {TARGETS[m][0]}（第{TARGETS[m][1]}轮）　命中率 {h:.2f}")
        print(f"    目标: {TARGETS[m][2][:54]}…")
        print(f"    转写: {text[:54]}…")

    with open(os.path.join(args.out, "联合切分结果.json"), "w", encoding="utf-8") as fh:
        json.dump({"cuts": cuts, "sum": round(score, 3), "parts": rows}, fh, ensure_ascii=False, indent=1)
    print(f"\n已写出 {args.out}\\联合切分结果.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
