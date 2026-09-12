# 本地实时语音语义交互 + Web Agent 自动化平台技术方案

> 目标：在现有 Web 平台中实现一套 **纯本地部署、低延迟、可控回复、可执行平台自动化操作** 的语音交互系统。  
> 用户可以直接说话，系统实时转文字，再进行语义理解，根据意图输出指定文本/音频，或调用平台内部工具完成自动化操作，以体现 Agent 能力。

---

# 1. 最终目标

系统交互链路：

```text
用户说话
   ↓
浏览器实时采集音频
   ↓
VAD 判断说话开始 / 结束
   ↓
Streaming ASR 实时语音转文字
   ↓
实时字幕显示
   ↓
语义理解 / Intent 识别
   ↓
参数提取
   ↓
Intent Router
   ├── 固定文字回复
   ├── 固定音频回复
   ├── TTS 语音回复
   ├── 页面跳转
   ├── 调用平台 API
   ├── 控制设备 / ROS
   └── Agent 多步骤任务
            ↓
       状态持续回传
            ↓
       Web UI + 语音反馈
```

典型例子：

```text
用户：
“介绍一下这套系统。”

→ ASR
→ intent = system_intro
→ 播放预设真人音频
→ 显示预设字幕
```

```text
用户：
“帮我打开巡检任务页面。”

→ ASR
→ intent = open_patrol_page
→ 调用 navigate_page 工具
→ 前端跳转 /patrol
→ 回复：“好的，已经打开巡检任务页面。”
```

```text
用户：
“让小车先去一号木柱，再绕一圈，然后回来。”

→ ASR
→ 识别为 Agent 任务
→ 提取：
   target = 一号木柱
   action_1 = 导航
   action_2 = 环绕巡检
   action_3 = 返回
→ Agent 编排多个 Tool
→ 实时显示执行步骤
→ 完成后语音反馈
```

---

# 2. 核心设计原则

本项目不建议所有请求都交给大模型。

建议采用：

```text
低延迟确定性请求
        ↓
规则 / Embedding
        ↓
直接执行

复杂自然语言任务
        ↓
Local LLM
        ↓
Agent Planner
        ↓
Tool Calling
```

即：

```text
简单问题 → 不经过 LLM
复杂任务 → 才经过 LLM
```

这样可以同时获得：

- 低延迟
- 高稳定性
- 纯本地
- 回复可控
- Agent 能力
- 后期容易扩展

---

# 3. 总体架构

```text
┌──────────────────────────────────────┐
│              Web Browser             │
│                                      │
│  Microphone                           │
│  AudioWorklet                         │
│  实时字幕                              │
│  Agent 状态                           │
│  Audio Player                         │
└──────────────────┬───────────────────┘
                   │
                   │ WebSocket
                   │ PCM Audio
                   ▼
┌──────────────────────────────────────┐
│            Voice Gateway             │
│                                      │
│  VAD                                 │
│  Streaming ASR                       │
│  Session Manager                     │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│          Semantic Router             │
│                                      │
│  Rule Matcher                        │
│  Embedding Matcher                   │
│  Entity / Slot Extractor             │
│  Confidence Manager                  │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│           Intent Dispatcher          │
│                                      │
│  RESPONSE                            │
│  NAVIGATION                          │
│  ACTION                              │
│  AGENT                               │
└───────┬──────────────┬───────────────┘
        │              │
        ▼              ▼
┌──────────────┐  ┌───────────────────┐
│Response      │  │ Agent Runtime     │
│Manager       │  │                   │
│              │  │ Local LLM         │
│文字 / 音频   │  │ Planner           │
│预设 TTS      │  │ Tool Calling      │
└──────┬───────┘  └────────┬──────────┘
       │                   │
       │                   ▼
       │          ┌───────────────────┐
       │          │   Tool Registry   │
       │          │                   │
       │          │ Web API           │
       │          │ 页面导航           │
       │          │ 数据查询           │
       │          │ ROS / Robot       │
       │          │ Camera            │
       │          │ SLAM              │
       │          │ Workflow          │
       │          └────────┬──────────┘
       │                   │
       └───────────┬───────┘
                   ▼
            Browser / Device
```

---

# 4. 推荐技术栈

## 4.1 Web 前端

如果现有平台已经使用 Vue，推荐直接：

```text
Vue 3
TypeScript
Pinia
WebSocket
Web Audio API
AudioWorklet
```

前端主要负责：

- 麦克风采集
- 音频流发送
- 实时字幕
- Agent 状态展示
- 音频播放
- 页面自动操作
- 用户打断
- UI 联动

---

# 5. 后端

推荐：

```text
Python 3.11+
FastAPI
WebSocket
asyncio
Pydantic
```

目录建议：

```text
server/
├── main.py
├── api/
│   ├── routes.py
│   └── websocket.py
│
├── voice/
│   ├── vad.py
│   ├── asr.py
│   └── session.py
│
├── semantic/
│   ├── embedder.py
│   ├── intent_matcher.py
│   ├── entity_extractor.py
│   └── router.py
│
├── agent/
│   ├── runtime.py
│   ├── planner.py
│   ├── executor.py
│   └── context.py
│
├── tools/
│   ├── registry.py
│   ├── web_tools.py
│   ├── robot_tools.py
│   ├── slam_tools.py
│   └── camera_tools.py
│
├── response/
│   ├── manager.py
│   ├── audio.py
│   └── tts.py
│
├── intents/
│   └── intents.json
│
├── config/
│   └── settings.yaml
│
└── data/
    ├── audio/
    └── vectors/
```

---

# 6. 实时语音采集

浏览器：

```javascript
navigator.mediaDevices.getUserMedia({
  audio: true
})
```

推荐使用：

```text
AudioWorklet
```

而不是优先使用：

```text
MediaRecorder
```

因为 AudioWorklet 更适合实时 PCM 流。

推荐格式：

```text
PCM
16 kHz
16 bit
Mono
```

即：

```text
PCM_S16LE
16000 Hz
1 Channel
```

每：

```text
20 ~ 40 ms
```

发送一次 Audio Chunk。

通过：

```text
WebSocket
```

发送到本地服务器。

---

# 7. VAD：语音活动检测

作用：

```text
判断用户什么时候开始说话
判断什么时候说完
```

推荐：

```text
FunASR FSMN-VAD
```

或者：

```text
Silero VAD
```

推荐参数初始值：

```yaml
vad:
  start_threshold_ms: 150
  end_silence_ms: 500
  max_utterance_ms: 15000
```

实际体验：

```text
用户说话
──────────────
              ↓
         静音约 500ms
              ↓
        sentence_end
              ↓
       触发最终语义判断
```

同时可以用于实现：

```text
Barge-in
用户打断
```

例如系统正在播放：

```text
“我们的平台主要用于……”
```

用户突然说：

```text
“等等，小车是干什么的？”
```

检测到 `speech_start` 后立即：

```text
停止当前音频
↓
开启新一轮 ASR
```

这个功能非常重要。

---

# 8. 实时 ASR

推荐：

```text
FunASR
+
Paraformer Streaming
```

目标：

```text
语音 → 实时中文文字
```

例如：

```text
用户正在说：

“帮我打开巡检任务页面”
```

前端显示：

```text
帮
帮我
帮我打开
帮我打开巡检
帮我打开巡检任务
帮我打开巡检任务页面
```

最终：

```json
{
  "type": "asr_final",
  "text": "帮我打开巡检任务页面"
}
```

---

# 9. WebSocket 通信协议

建议所有事件统一封装。

## 9.1 ASR Partial

```json
{
  "type": "asr_partial",
  "session_id": "xxx",
  "text": "帮我打开巡检"
}
```

## 9.2 ASR Final

```json
{
  "type": "asr_final",
  "session_id": "xxx",
  "text": "帮我打开巡检任务页面"
}
```

## 9.3 Intent

```json
{
  "type": "intent",
  "intent": "open_patrol_page",
  "confidence": 0.94
}
```

## 9.4 Agent Step

```json
{
  "type": "agent_step",
  "step": 2,
  "name": "robot_navigation",
  "status": "running",
  "message": "正在让小车前往一号木柱"
}
```

## 9.5 Agent Finish

```json
{
  "type": "agent_finish",
  "status": "success",
  "message": "任务执行完成"
}
```

---

# 10. 语义理解架构

建议采用三级结构：

```text
Rule Matcher
      ↓
Embedding Matcher
      ↓
Local LLM
```

不同请求进入不同层。

---

# 11. 一级：规则识别

对于高确定性指令：

```text
停止
暂停
继续
取消
返回
首页
紧急停止
```

直接规则处理。

例如：

```python
STOP_WORDS = [
    "停",
    "停止",
    "停下",
    "别动",
    "立即停止"
]
```

匹配后：

```text
intent = robot_stop
```

不需要 Embedding，不需要 LLM。

理论延迟接近：

```text
0 ms
```

---

# 12. 二级：Embedding Intent 匹配

推荐：

```text
BAAI/bge-small-zh-v1.5
```

适合：

```text
固定 Intent
+
不同自然语言表达
```

例如系统只定义：

```text
打开巡航任务页面
```

但用户可以说：

```text
让我看看巡检任务
进入任务中心
打开机器人任务页面
我想看一下小车现在的任务
巡航任务在哪
```

全部匹配：

```text
intent = open_patrol_page
```

---

# 13. Intent 数据结构

推荐配置：

```json
{
  "id": "open_patrol_page",
  "name": "打开巡航任务页面",
  "type": "navigation",

  "examples": [
    "打开巡航任务",
    "进入巡航页面",
    "让我看看巡检任务",
    "打开机器人任务中心",
    "我想看一下小车任务"
  ],

  "response": {
    "text": "好的，正在打开巡航任务页面。",
    "audio": "/audio/open_patrol_page.wav"
  },

  "action": {
    "tool": "navigate_page",
    "params": {
      "route": "/patrol"
    }
  }
}
```

---

# 14. Embedding 匹配方式

启动服务器时：

```text
所有 Intent Example
        ↓
bge-small-zh-v1.5
        ↓
Embedding
        ↓
保存在内存
```

用户输入：

```text
“我想看看机器人现在有什么巡检任务”
```

转换成：

```text
Query Vector
```

计算：

```text
Cosine Similarity
```

示例结果：

```text
open_patrol_page     0.92
robot_status         0.70
start_patrol         0.65
system_intro         0.28
```

最终：

```text
open_patrol_page
```

---

# 15. 阈值不要写死

不要简单写：

```python
if score > 0.8:
```

建议：

```text
Top1 Score
+
Top1 - Top2 Margin
```

例如：

```text
Top1 = 0.92
Top2 = 0.65

Margin = 0.27
```

则可信度很高。

建议初始策略：

```yaml
semantic:
  high_confidence: 0.82
  low_confidence: 0.68
  min_margin: 0.08
```

具体阈值必须使用你自己的问句数据集测试后确定。

---

# 16. Intent 数量较小时不需要向量数据库

如果：

```text
20 ~ 500 Intent
```

直接：

```text
NumPy
+
Cosine Similarity
```

即可。

如果后期：

```text
几千 ~ 几万知识项
```

可以使用：

```text
FAISS
```

仍然完全本地。

---

# 17. Entity / Slot 参数提取

Intent 只知道“做什么”。

还需要知道：

```text
对谁做
在哪做
什么时候做
参数是多少
```

例如：

```text
“让小车去二号木柱。”
```

结果：

```json
{
  "intent": "robot_move",
  "entities": {
    "target": "柱子_2"
  }
}
```

例如：

```text
“让小车以 0.2 米每秒去一号柱。”
```

输出：

```json
{
  "intent": "robot_move",
  "entities": {
    "target": "柱子_1",
    "speed": 0.2
  }
}
```

简单场景：

```text
Regex
+
Dictionary
```

复杂场景才使用：

```text
Local LLM
```

---

# 18. Intent 类型设计

推荐统一为：

```text
RESPONSE
NAVIGATION
ACTION
QUERY
AGENT
```

---

## RESPONSE

固定知识回答。

例如：

```text
“介绍一下你们这个项目。”
```

执行：

```text
播放预设音频
+
显示固定文本
```

---

## NAVIGATION

Web 页面操作。

例如：

```text
“打开地图。”
```

执行：

```text
navigate_page("/map")
```

---

## ACTION

单步骤操作。

例如：

```text
“开始巡航。”
```

执行：

```text
start_patrol()
```

---

## QUERY

查询平台数据。

例如：

```text
“小车现在电量多少？”
```

调用：

```text
get_robot_status()
```

返回：

```text
battery = 78%
```

然后回答：

```text
“小车当前电量为 78%。”
```

---

## AGENT

多步骤复杂任务。

例如：

```text
“让小车去一号柱，采集一圈，然后去二号柱，最后回起点。”
```

需要：

```text
规划
+
多个 Tool
+
状态反馈
```

进入 Agent。

---

# 19. Agent 架构

推荐：

```text
User Command
     ↓
Intent Router
     ↓
Agent Required?
     ↓ YES
Local LLM
     ↓
Planner
     ↓
Structured Plan
     ↓
Tool Executor
     ↓
Observation
     ↓
Next Step
     ↓
Finish
```

核心不是：

```text
让 AI 操作鼠标
```

而是：

```text
让 Agent 调用明确的 Tool/API
```

这是最稳定的方案。

---

# 20. Agent Tool Calling

每一个平台能力都包装成一个 Tool。

例如：

```python
@tool
def navigate_page(route: str):
    pass
```

```python
@tool
def robot_move(target: str):
    pass
```

```python
@tool
def robot_stop():
    pass
```

```python
@tool
def start_patrol(task_id: str):
    pass
```

```python
@tool
def get_robot_status():
    pass
```

```python
@tool
def load_map(map_id: str):
    pass
```

---

# 21. Tool Registry

统一注册：

```text
Tool Registry
│
├── navigate_page
├── open_panel
├── robot_move
├── robot_stop
├── robot_return_home
├── start_patrol
├── cancel_patrol
├── get_robot_status
├── get_map_list
├── load_map
├── start_scan
├── stop_scan
└── get_camera_status
```

Agent 只能操作：

```text
Registry 中允许调用的 Tool
```

不能直接任意执行代码。

---

# 22. 推荐 Tool Schema

```json
{
  "name": "robot_move",
  "description": "让机器人前往指定目标点",
  "parameters": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "description": "目标点名称"
      }
    },
    "required": ["target"]
  }
}
```

---

# 23. Agent 执行示例

用户：

```text
“让小车去一号木柱拍摄一圈，然后回来。”
```

Agent Planner：

```json
{
  "goal": "完成一号木柱巡检并返回",
  "steps": [
    {
      "tool": "robot_move",
      "args": {
        "target": "pillar_1"
      }
    },
    {
      "tool": "camera_record_start",
      "args": {}
    },
    {
      "tool": "robot_circle_target",
      "args": {
        "target": "pillar_1"
      }
    },
    {
      "tool": "camera_record_stop",
      "args": {}
    },
    {
      "tool": "robot_return_home",
      "args": {}
    }
  ]
}
```

---

# 24. Agent UI

如果要体现 Agent 能力，非常建议前端显示：

```text
✓ 理解任务

✓ 生成执行计划

✓ 前往一号木柱

● 正在环绕一号木柱

○ 停止录像

○ 返回起点
```

这样用户可以明显看到：

```text
AI 不只是在聊天
而是在执行任务
```

这是项目展示时非常重要的一点。

---

# 25. Agent 状态机

推荐：

```text
IDLE

LISTENING

RECOGNIZING

UNDERSTANDING

PLANNING

EXECUTING

WAITING_TOOL

RESPONDING

FINISHED

ERROR
```

前端根据状态显示动画。

---

# 26. 本地 LLM

本项目中 LLM 不是核心聊天模型。

主要职责：

```text
复杂自然语言理解
参数提取
任务规划
Tool Calling
```

可选本地模型：

```text
Qwen 系列小型 / 中型 Instruct 模型
```

部署方式：

CPU / 小模型：

```text
llama.cpp
```

快速开发：

```text
Ollama
```

NVIDIA GPU：

```text
vLLM
```

如果硬件资源有限：

```text
Embedding + Rule
```

承担绝大多数请求。

只把：

```text
Agent 请求
```

发送给 LLM。

---

# 27. 为什么不建议所有请求都经过 LLM

如果：

```text
ASR
 ↓
LLM
 ↓
TTS
```

每句话都这样，会增加：

- TTFT
- GPU 占用
- 不稳定性
- 幻觉
- 不可控输出

本项目应该：

```text
ASR
 ↓
Semantic Router
 ↓
90% 直接匹配
 ↓
指定结果

复杂请求
 ↓
LLM Agent
```

---

# 28. 回复系统

Response Manager 负责：

```text
文字
音频
动画
表情
页面操作提示
```

统一输出：

```json
{
  "text": "正在打开巡检页面。",
  "audio": "/audio/open_patrol.wav",
  "emotion": "normal",
  "animation": "confirm"
}
```

---

# 29. 音频回复方案

如果回复内容预先确定，最佳方案是：

```text
提前生成音频
```

而不是：

```text
运行时实时 TTS
```

流程：

```text
Intent
 ↓
audio_id
 ↓
直接播放 WAV / OGG
```

优点：

- 延迟最低
- 声音自然
- 每次效果一致
- 不占实时 GPU
- 可以人工挑选最自然版本

---

# 30. 最自然的声音方案

优先级：

```text
1. 真人提前录音
2. 高质量 TTS 提前生成
3. 实时本地 TTS
```

例如：

```text
system_intro_01.wav
system_intro_02.wav
system_intro_03.wav
```

同一个意图准备多个版本随机播放，可以降低机械感。

---

# 31. 实时 TTS

对于动态数据：

```text
“小车当前电量为 73%。”
```

无法全部提前录音。

此时才进入：

```text
Local TTS
```

推荐架构：

```text
固定回答
→ 预录音

动态回答
→ TTS
```

形成混合模式。

---

# 32. 页面自动化不要模拟鼠标

如果 Web 平台是你自己开发的：

不要优先：

```text
模拟鼠标
模拟键盘
DOM 强制点击
```

应该：

```text
Agent
 ↓
Tool
 ↓
调用平台内部 API / Store / Router
```

例如用户说：

```text
“打开三维地图。”
```

Agent：

```text
navigate_page
```

前端执行：

```javascript
router.push("/map3d")
```

这样最稳定。

---

# 33. Web 自动化 Tool

可以设计：

```text
navigate_page
open_dialog
close_dialog
select_robot
select_map
set_camera
create_task
start_task
cancel_task
show_pointcloud
switch_view
```

例如：

```json
{
  "tool": "switch_view",
  "args": {
    "view": "pointcloud"
  }
}
```

---

# 34. ROS / 小车集成

如果平台后面需要控制 ROS：

推荐：

```text
Agent
 ↓
Backend Tool
 ↓
ROS Bridge / ROS Node
 ↓
move_base
```

例如：

```text
robot_move("pillar_1")
```

后端将目标转换为：

```text
geometry_msgs/PoseStamped
```

发送给：

```text
/move_base/goal
```

Agent 不需要理解 ROS Topic 细节。

Agent 只理解：

```text
robot_move
robot_stop
robot_return_home
start_patrol
```

---

# 35. 小车 Tool 示例

```text
get_robot_status()

robot_move(target)

robot_stop()

robot_return_home()

start_patrol(route)

cancel_patrol()

rotate_robot(angle)

set_speed(speed)
```

---

# 36. SLAM Tool

例如：

```text
start_mapping()

stop_mapping()

save_map(name)

load_map(name)

get_mapping_status()

show_map(name)
```

用户：

```text
“开始建图。”
```

→

```text
start_mapping()
```

---

# 37. 三维重建 Tool

后续可以扩展：

```text
create_reconstruction_task()

get_reconstruction_status()

open_3d_model()

show_pointcloud()

switch_gaussian_view()
```

用户：

```text
“打开刚才生成的三维模型。”
```

Agent：

```text
get_latest_model()
↓
open_3d_model()
```

这就是很明显的 Agent 工作流。

---

# 38. 推荐 Intent 配置完整示例

```json
{
  "id": "system_intro",

  "type": "response",

  "examples": [
    "介绍一下这个平台",
    "这个系统是干什么的",
    "你们这个项目有什么用",
    "介绍一下你们的项目",
    "这个平台主要实现什么功能"
  ],

  "response": {
    "text": "本平台主要用于古建筑数字化采集、机器人自主巡检以及三维数据管理。",
    "audio": "/audio/system_intro_01.wav"
  }
}
```

---

# 39. ACTION Intent 示例

```json
{
  "id": "open_map",

  "type": "navigation",

  "examples": [
    "打开地图",
    "进入地图页面",
    "让我看看地图",
    "查看当前地图"
  ],

  "response": {
    "text": "好的，正在打开地图。"
  },

  "action": {
    "tool": "navigate_page",
    "params": {
      "route": "/map"
    }
  }
}
```

---

# 40. Robot Action 示例

```json
{
  "id": "robot_return_home",

  "type": "action",

  "examples": [
    "让小车回来",
    "让机器人返回",
    "回到起点",
    "让小车回充电站"
  ],

  "response": {
    "text": "好的，正在让小车返回。"
  },

  "action": {
    "tool": "robot_return_home"
  }
}
```

---

# 41. Fallback

系统必须有：

```text
Unknown Intent
```

不要低置信度也强制执行。

例如：

```text
Top1 < Threshold
```

返回：

```text
“我没有理解你的指令，可以换一种说法。”
```

而不是错误操作机器人。

---

# 42. 高风险动作需要确认

例如：

```text
删除地图
停止正在执行的任务
覆盖数据
启动机器人移动
清空记录
```

可以增加：

```text
Confirm Layer
```

例如：

```text
用户：
“删除当前地图。”

系统：
“确认删除当前地图吗？”

用户：
“确认。”

→ 执行
```

---

# 43. Agent 权限系统

每个 Tool 定义风险等级：

```text
LEVEL 0
查询

LEVEL 1
UI 操作

LEVEL 2
普通设备操作

LEVEL 3
机器人运动

LEVEL 4
危险 / 删除操作
```

例如：

```json
{
  "name": "delete_map",
  "risk": 4,
  "require_confirmation": true
}
```

---

# 44. 防止 LLM 幻觉调用

Agent 必须：

```text
只能选择 Tool Registry 中存在的工具
```

不能：

```text
自由生成 shell command
自由执行 Python
自由访问系统
```

即：

```text
LLM
 ↓
JSON Tool Call
 ↓
Schema Validate
 ↓
Permission Check
 ↓
Execute
```

---

# 45. 推荐完整请求处理流程

```text
Audio Chunk
     ↓
VAD
     ↓
Streaming ASR
     ↓
Partial Text
     ↓
Web Subtitle
     ↓
Final Text
     ↓
Normalize
     ↓
Rule Matcher
     │
     ├─ Hit
     │    ↓
     │   Execute
     │
     └─ Miss
          ↓
     Embedding
          ↓
     Similarity
          │
          ├─ High Confidence
          │       ↓
          │   Intent Execute
          │
          ├─ Medium Confidence
          │       ↓
          │    Re-Rank / LLM
          │
          └─ Complex Task
                  ↓
               Agent
                  ↓
                Plan
                  ↓
             Tool Calling
                  ↓
               Result
                  ↓
             Response
```

---

# 46. 推荐响应延迟目标

## 实时字幕

目标：

```text
100 ~ 300 ms 级更新
```

## 用户停顿后进入语义处理

主要时间：

```text
VAD End Silence
```

可以控制约：

```text
400 ~ 600 ms
```

## Embedding Intent

本地运行目标：

```text
毫秒 ~ 数十毫秒级
```

## 预录音播放

命中后：

```text
几乎立即播放
```

因此固定意图体验应该做到：

```text
用户说完
↓
约 0.5 ~ 1 秒内开始回应
```

真正瓶颈往往不是 Embedding，而是：

```text
等待判断用户是否说完
```

---

# 47. 低延迟优化

## ASR

使用：

```text
Streaming ASR
```

不要等完整 WAV 文件。

---

## Embedding

Intent Vector：

```text
服务器启动时提前计算
```

不要每次重新计算所有 Intent。

---

## Audio

预加载常见音频：

```text
AudioBuffer Cache
```

---

## LLM

只有 Agent 使用。

可以保持：

```text
Model 常驻显存
```

避免每次加载。

---

# 48. 推荐硬件部署方式

如果有：

```text
RTX PC
```

推荐：

```text
Web Server
+
FunASR
+
Embedding
+
Local LLM
+
TTS
```

全部部署在一台设备。

---

如果使用：

```text
Jetson Orin Nano 8GB
```

建议：

```text
VAD
ASR
Embedding
Agent Runtime
ROS
```

放 Jetson。

大型 LLM 或高质量实时 TTS：

```text
尽量不要作为第一版核心依赖
```

固定回答直接使用预生成音频。

---

# 49. 第一版 MVP

建议第一阶段只实现：

```text
麦克风
↓
Streaming ASR
↓
实时字幕
↓
Embedding Intent
↓
固定回答
↓
固定音频
```

完成后已经可以实现：

```text
自然语言问答
```

---

# 50. 第二阶段

增加：

```text
页面自动化
```

例如：

```text
打开地图
打开设备状态
打开巡检任务
打开三维模型
切换点云视图
```

完成后：

```text
语音 → Web 操作
```

---

# 51. 第三阶段

增加：

```text
机器人 Tool
```

例如：

```text
机器人状态
移动
停止
返回
巡航
```

完成：

```text
语音 → 实体设备
```

---

# 52. 第四阶段

加入：

```text
Local LLM
+
Agent Planner
```

支持：

```text
多步骤任务
```

例如：

```text
“先打开地图，然后让小车去一号柱，采集完成之后回来，并打开刚才的巡检记录。”
```

执行：

```text
1. navigate_page("/map")

2. robot_move("pillar_1")

3. start_scan()

4. wait scan complete

5. robot_return_home()

6. get_latest_record()

7. open_record()
```

---

# 53. 第五阶段

加入：

```text
Agent Memory / Context
```

例如：

用户：

```text
“去一号柱。”
```

完成后：

```text
“再去下一个。”
```

系统知道：

```text
上一个 = 一号柱
下一个 = 二号柱
```

这时才有真正连续对话的感觉。

---

# 54. 推荐最终技术选型

## Frontend

```text
Vue 3
TypeScript
Web Audio API
AudioWorklet
WebSocket
```

## Backend

```text
Python
FastAPI
asyncio
```

## VAD

```text
FSMN-VAD
```

或：

```text
Silero VAD
```

## ASR

```text
FunASR
Paraformer Streaming
```

## Semantic Embedding

```text
BAAI/bge-small-zh-v1.5
```

## Vector Search

第一版：

```text
NumPy
```

后期：

```text
FAISS
```

## Agent

```text
自定义 Agent Runtime
+
Local LLM
+
JSON Tool Calling
```

## Local LLM

```text
Qwen 系列 Instruct 模型
```

## Model Runtime

```text
Ollama
```

快速开发。

后期根据 GPU：

```text
llama.cpp
/
vLLM
```

## TTS

```text
固定回答：
预生成音频

动态回答：
Local TTS
```

---

# 55. 推荐项目最终链路

```text
┌───────────┐
│ Microphone│
└─────┬─────┘
      │
      ▼
┌─────────────┐
│ AudioWorklet│
└──────┬──────┘
       │ WebSocket
       ▼
┌─────────────┐
│     VAD     │
└──────┬──────┘
       ▼
┌─────────────────┐
│ Streaming FunASR│
└───────┬─────────┘
        │
        ▼
┌─────────────────┐
│ Semantic Router │
└────┬─────┬──────┘
     │     │
     │     └────────复杂任务─────────┐
     │                              ▼
     │                       ┌──────────────┐
     │                       │ Local LLM    │
     │                       │ Agent Planner│
     │                       └──────┬───────┘
     │                              │
     ▼                              ▼
┌──────────────┐            ┌───────────────┐
│ Fixed Intent │            │ Tool Registry │
└──────┬───────┘            └──────┬────────┘
       │                           │
       ▼                           ▼
┌──────────────┐           ┌────────────────┐
│Response      │           │ Web / ROS / API│
│Text / Audio  │           │ Device Action  │
└──────┬───────┘           └───────┬────────┘
       │                           │
       └─────────────┬─────────────┘
                     ▼
               ┌────────────┐
               │ Web Browser│
               └────────────┘
```

---

# 56. 最关键的一点

这个项目真正体现 Agent 的地方，不是：

```text
能聊天
```

而是：

```text
听懂用户自然语言
        ↓
理解用户目标
        ↓
决定应该调用哪些能力
        ↓
组合多个工具
        ↓
执行真实操作
        ↓
根据执行结果继续决策
        ↓
最后向用户反馈
```

因此产品展示时建议强调：

```text
Voice Interface
+
Semantic Understanding
+
Tool Calling
+
Autonomous Workflow
```

而不是单纯称为：

```text
语音助手
```

更准确的定位可以叫：

# 基于自然语言交互的本地多工具 Agent 控制平台

---

# 57. 推荐实施顺序

```text
Step 1
Web 麦克风采集

↓

Step 2
WebSocket PCM

↓

Step 3
FunASR Streaming

↓

Step 4
实时字幕

↓

Step 5
BGE Intent

↓

Step 6
固定文字 / 音频回复

↓

Step 7
Web Tool Registry

↓

Step 8
页面自动化

↓

Step 9
机器人 API / ROS Tool

↓

Step 10
Local LLM

↓

Step 11
Agent Planner

↓

Step 12
多 Tool Workflow

↓

Step 13
Context / Memory

↓

Step 14
数字人 / 表情 / Lip Sync
```

建议严格按照这个顺序开发。

不要第一天就：

```text
LLM + Agent + ASR + TTS + Robot
```

一起接。

应该先保证：

```text
语音输入
→ 准确 Intent
→ 稳定 Tool
```

再增加 Agent。

---

# 58. 建议验收指标

## ASR

```text
普通中文指令识别准确率 > 95%
```

基于你自己的指令数据集测试。

## Intent

```text
Top-1 Intent Accuracy > 95%
```

## 固定回复首响

```text
用户结束说话后 < 1s
```

## Tool

```text
执行成功率 > 99%
```

## Agent

```text
简单多步骤任务成功率 > 90%
```

## Safety

```text
低置信度不执行高风险操作
高风险 Tool 必须确认
```

---

# 59. 最终推荐方案总结

第一版核心：

```text
Vue 3
+
Web Audio API
+
AudioWorklet
+
WebSocket
+
FastAPI
+
FSMN-VAD
+
FunASR Paraformer Streaming
+
BGE-small-zh-v1.5
+
Intent JSON
+
固定音频
```

第二版增加：

```text
Tool Registry
+
Web Platform API
+
ROS Tool
```

第三版增加：

```text
Local Qwen
+
Agent Planner
+
Tool Calling
+
Multi-step Workflow
```

最终形成：

```text
语音
↓
实时字幕
↓
语义理解
↓
Intent / Agent Routing
↓
固定回答 or Tool Calling
↓
Web / Robot / SLAM / Camera 操作
↓
实时状态
↓
语音反馈
```

这条技术路线可以同时满足：

```text
✅ 纯本地部署
✅ 实时语音转文字
✅ 不同表达方式识别同一语义
✅ 固定内容回复
✅ 指定音频回复
✅ 动态语音回复
✅ Web 平台自动化
✅ ROS / 小车控制
✅ 多步骤 Agent
✅ 用户打断
✅ 较低延迟
✅ 可控性高
✅ 后期可扩展数字人
```

---

# 60. 推荐下一步开发任务

第一周可以直接完成下面的 MVP：

```text
[ ] 浏览器麦克风
[ ] AudioWorklet
[ ] WebSocket PCM
[ ] FunASR Streaming
[ ] 实时字幕
[ ] Intent JSON
[ ] BGE Embedding
[ ] Cosine Similarity
[ ] Intent Router
[ ] 固定文字回复
[ ] 固定音频播放
```

MVP 完成后再加入：

```text
[ ] navigate_page Tool
[ ] robot_status Tool
[ ] robot_move Tool
[ ] Tool Registry
[ ] Agent Runtime
[ ] Local LLM
[ ] Multi-step Planner
```

这样开发风险最低，也最容易在比赛或展示前先做出稳定版本。
