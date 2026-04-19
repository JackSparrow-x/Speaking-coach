# Ideas / Backlog

记录产品演进方向和技术优化点，未决定做不做、不属于 V1 范围。每条以后单独讨论。

---

## Prosody 整句语调分析（点击 Prosody 分数展开）

**背景**：Azure 的单词级 Accuracy 评分不考虑连读弱化，容易误判正常弱读为"发音不准"。但 Prosody 分数是整句级的，且 Azure 返回了细分数据：
- `Feedback.Prosody.Break.ErrorTypes`：UnexpectedBreak / MissingBreak
- `Feedback.Prosody.Intonation.Monotone.Confidence`：语调是否过于平板
- 每个词的 `BreakLength`：停顿长度

**产品设计**：
- 点击 Prosody 分数 → 展开一个"整句语调分析"区域
- 显示：异常停顿标记、单调度评估
- LLM 解读：基于上述数据，给出"哪里该升调但你降了"之类的建议
- 后端 `simplifyPronunciation` 需要额外提取 `Feedback.Prosody` 数据

**优先级**：中。等 V2 基础功能稳定后再做。

---

## 场景图交互方案（待用户有精力时推进）

**产品目标**：进入场景后看到一张场景图（咖啡厅/机场/诊室等），图上物品可点击，点了显示英文名称+发音+例句，然后可以围绕这些物品展开对话。

**生成流程**（用户提出的方案）：
1. 设计 20+ 个常见场景的详细描述（包含物品清单）
2. 用文生图工具（Midjourney/DALL-E/Stable Diffusion）生成场景图
3. 在图上标注物品做成可交互的

**交互实现四种方案**：

| 方案 | 怎么做 | 优劣 |
|------|--------|------|
| A. 图片热区（Image Map） | 人工在图上标注矩形坐标，每个坐标绑定一个物品 | 最直观，但每张图要手动标注 |
| B. AI 辅助标注 | 用 GPT-4V 分析图片 → 自动识别物品+位置 → 生成坐标 JSON → 人工微调 | 最省力，但需要 Vision API + 结果不一定精确 |
| C. 场景词汇清单（简化版） | 不做图片交互，只在场景顶部显示"核心词列表"（可点击听发音） | 最简单，适合 V1 过渡 |
| D. 分层叠加 | 物品做成独立透明 PNG，CSS absolute 定位叠到背景上 | 最灵活但美术量大 |

**推荐路径**：先做方案 C（词汇清单版），用起来；然后尝试方案 B（AI 辅助标注），把 C 升级成真正的图片交互。

**数据格式设计**（每个场景）：
```json
{
  "id": "coffee-shop",
  "name": "Coffee Shop",
  "image": "/scenes/coffee-shop.png",
  "items": [
    { "name": "espresso machine", "x": 120, "y": 80, "w": 60, "h": 40, "description": "...", "example": "Could I get a double shot from the espresso machine?" },
    { "name": "pastry display", "x": 200, "y": 150, ... },
    ...
  ]
}
```

**依赖**：
- 用户制作场景图（美术）
- 物品坐标标注（人工或 AI 辅助）
- 前端渲染（Image Map 或 CSS overlay）

**优先级**：低。等数据层 + 智能层做完，且用户有精力做图时再推进。

---

## 转录优化：借鉴 Typeless 的思路

**场景**：英语陪练的语音识别。Azure STT 原生能识别出说的内容，但不处理：
- 语气词（"uh"、"um"、"嗯"、"啊"）
- 重复/犹豫（"I... I think... I think that..."）
- 中途改口（"I want coffee, actually tea"）

**Typeless 的做法**（值得借鉴的点）：
- filler word removal：自动去除语气词
- repetition detection：识别并清理重复
- self-correction：中途改口时保留最终意图
- 全部是"说完一口气→输出干净文本"的工作流，而不是逐字实时展示

**对我们项目的意义**：
- 用户说 "Um, I think... I think the coffee is, uh, nice" 时，识别出来应该是 "I think the coffee is nice"
- 这能让后续的"发音评估"和"AI 对话"都基于更干净的文本
- 但也要注意：语气词和犹豫本身是重要的**语言流畅度信号**，完全滤掉可能丢失诊断信息
  - 可能的方案：原始 transcript 保留所有内容（给发音评估用），额外输出一份"清理版"给对话系统

**可选实现路径**（待进一步讨论）：
- 方案 A：Azure STT 原生识别 → LLM 二次清洗（额外一次 LLM 调用）
- 方案 B：换底层 STT，看有没有内置清洗能力的方案
- 方案 C：寻找开源的 Typeless 替代方案（Superwhisper、Tambourine、Wispr Flow 等）作参考

**决策前需要确认**：
1. 我们到底是"要干净文本"还是"要原样文本+清理版两份"
2. 清洗对后续"发音评估"的影响（评分是基于原始音频还是清理后文本？）
3. 成本是否能接受（LLM 二次调用会拖慢响应）

---
