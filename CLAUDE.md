@AGENTS.md

# 英语口语陪练项目 — 项目状态与上下文

## 一句话介绍

一个给用户女朋友练英语口语的 Web App：录音 → Azure 发音评估 → Claude Opus 对话 → Azure TTS 自动播放。核心差异化是"自由对话主线 + 专业级发音评估"——市面上 Speak 做对话深但评估浅，ELSA 做评估深但是课程形态，这个项目想填中间的空白。

## 当前版本：V2.5（已上线）

**线上地址**：`https://speaking-coach-nine.vercel.app`
**GitHub**：`https://github.com/JackSparrow-x/Speaking-coach`
**用户**：项目作者的女朋友（一个真实用户）

### 已完成

- V1 核心闭环：录音 → STT → 发音评估 → Claude 对话 → TTS 播放
- V2 体验增强：
  - 6 个场景预设（Free Chat, Coffee Shop, Airport, Job Interview, Doctor Visit, Small Talk）
  - 切换场景时 AI 自动说 greeting 并播放
  - 单词点击展开 → 音素级分数 + LLM 中文发音解读（含连读弱读判断）+ 用户原录音片段播放 + 标准发音 TTS
  - Prosody 分数点击展开 → 整句语调分析（停顿、单调度、节奏示范）+ 标准语调播放
- 数据层（Turso SQLite 云版，本地 dev 跳过不写）
- 每日调用配额防刷（transcribe 200 / chat 500 / tts 500 / analysis 300）
- TTS 过滤 emoji + markdown 标记（不然会念出"星号"）
- Markdown 渲染（AI 回复、发音解读、Prosody 分析都用 react-markdown）
- Vercel 自动部署（git push main → 1-2 分钟生效）

## 技术栈 & 关键决策

| 模块 | 选型 | 理由 |
|------|------|------|
| 前端框架 | Next.js 16 + React 19 + TypeScript + Tailwind 4 | 一套搞定前端 + API Routes |
| LLM | Claude Opus（通过 Bedrock 代理） | 用户有代理 key，只开放 opus/haiku，选最强 |
| 对话模型 | `bedrock-claude-opus` | 对话、发音解读、整句分析全套用它 |
| STT / TTS / 发音评估 | Azure Speech（East US） | 国内卡能绑，STT 和发音评估同一请求 |
| 数据库 | Turso（SQLite 云版，`@libsql/client`） | 免费额度够、和 SQLite 语法一致 |
| 部署 | Vercel（Hobby 免费） | 和 Next.js 官方搭档，git push 自动部署 |

**关键：LLM 环境变量用 `CLAUDE_PROXY_*` 前缀**，不是 `ANTHROPIC_*`——因为 Claude Code 自己会占用 `ANTHROPIC_BASE_URL` 这个变量，会冲突。

## 代码结构速览

```
web/
├── app/
│   ├── page.tsx                    # 整个前端单页（Conversation + PronunciationCard + WordDetail + ProsodyDetail）
│   ├── layout.tsx
│   ├── globals.css
│   └── api/
│       ├── chat/route.ts           # Claude 对话 + 保存消息
│       ├── transcribe/route.ts     # Azure STT + 发音评估 + 保存评估记录
│       ├── tts/route.ts            # Azure TTS（过滤 emoji + markdown）
│       ├── analyze-word/route.ts   # 单词级 LLM 解读
│       ├── analyze-prosody/route.ts # 整句 LLM 语调分析
│       └── sessions/route.ts       # 创建对话会话，返回 sessionId
├── lib/
│   ├── llm.ts                      # Claude 调用封装（直接 fetch，绕过 SDK）
│   ├── db.ts                       # Turso 数据层 + 配额检查（本地 NODE_ENV=development 时全部跳过）
│   ├── scenarios.ts                # 6 个场景的 system prompt
│   └── audio-utils.ts              # WebM → WAV 转换（给 Azure STT 用）
├── docs/
│   └── ideas.md                    # 产品 backlog（场景图、Typeless 清洗等）
└── certificates/                   # mkcert 生成的本地 HTTPS 证书（已 gitignore）
```

## 数据库 schema（Turso）

5 张表，首次连接自动创建：

- `pronunciation_records` — 每次发音评估的完整数据
- `weak_phonemes` — 弱点音素统计（upsert 累加）
- `vocabulary` — 单词本（低分词自动加入）
- `conversation_sessions` — 对话会话 + 总结字段
- `conversation_messages` — 对话消息明细
- `usage_counter` — 每日调用计数（防刷）

本地开发 `NODE_ENV=development` 时，`getDb()` 返回 null，所有写入函数静默 no-op——**本地怎么折腾都不污染线上数据库**。

## 工作流规则（重要）

**这是生产环境项目，女朋友每天在用。遵守以下规则**：

1. **默认不要 `git push`**。改完代码后：
   - 先本地 `npm run dev` 或 `npm run dev:https` 测试
   - 用户在 `localhost:3000` 验证
   - 用户明确说"上云"/"推送"/"部署" 才 `git push`
2. **`dev:https` 是给手机测试用的**（用 mkcert 证书，手机 HTTPS 访问本机）。默认电脑开发用 `dev` 就够。
3. **环境变量在 Vercel dashboard 改**，本地 `.env.local` 只给本地用。两边独立不冲突。
4. **Vercel 的 Root Directory 设为 `web`**（项目在子目录）。

## 常用命令

```bash
npm run dev           # 普通开发（http://localhost:3000）
npm run dev:https     # HTTPS 开发（需要证书，给手机测试）
npm run build         # 生产构建
npm run lint          # 代码检查
```

Git 推送：

```bash
git add -A
git commit -m "..."
git push              # Vercel 自动部署
```

## 下一步路线图（按优先级）

### 🔥 第 2 层：智能层（下次对话的主线）

**目标**：让 AI 从"每次都是陌生人"变成"记住你、针对你弱点的教练"。

**要做的**：
1. 对话开始前，从 `weak_phonemes` 和 `vocabulary` 读取用户画像
2. 动态注入到 system prompt：`"This user struggles with /θ/ (often pronounced as /s/). Their vocabulary is simple—they overuse 'good/nice'. Naturally steer today's conversation to use think/three/the, and subtly introduce alternatives like decent/solid/gorgeous."`
3. AI 在对话中主动引导练习（用户感知上是自然聊天）

**前置**：数据库要有数据。用户女朋友用几天后再做，效果才看得到。

### 第 3 层：闭环体验

- 进入 App 时显示上次对话的"发现报告"（字段已埋好在 `conversation_sessions.summary`）
- 单词本独立页面（SRS 复习）
- 进步曲线（每天分数趋势图）

### 第 4 层：Native 表达建议

- 强化 system prompt，让 Claude 更主动纠错 + 给出地道说法
- 未来：对话后专门的"建议替代表达"功能

### 其他 backlog（在 `docs/ideas.md`）

- 场景图交互（需要用户做图 + AI 辅助物品标注）
- Typeless 风格的语气词过滤
- Prosody 增强
- 清理 debug 面板

## 已踩过的坑（避免重踩）

1. **Anthropic SDK baseURL 被 Claude Code 环境变量劫持** — 用 `CLAUDE_PROXY_*` 前缀避开
2. **Bedrock 代理不支持 Sonnet，只开放 Opus 和 Haiku** — 用 `bedrock-claude-opus`
3. **iOS Safari 不支持 audio/webm** — MediaRecorder 要 fallback 到 `audio/mp4`
4. **iOS Safari 对自签证书严格，getUserMedia 静默拒绝** — 要在 iPhone 安装 mkcert CA 根证书并完全信任
5. **Next.js 16 默认阻止 LAN IP 访问 dev 资源** — `next.config.ts` 加 `allowedDevOrigins`
6. **Azure REST API 返回的发音数据字段是平铺的**（不是 SDK 那种 `PronunciationAssessment` 嵌套）
7. **Unscripted 发音评估**：`ReferenceText` 字段必须**完全省略**，不能设空字符串
8. **STT 架构（V2.6）**：串行 Whisper → Azure Scripted。Whisper 先出准确转录 → 作为 `ReferenceText` 传给 Azure 做 Scripted 发音评估。之前并行跑 Azure Unscripted + Whisper 会导致词语标签（Azure 识别词）和气泡文本（Whisper 识别词）不一致，评分也建立在 Azure 错听的词上。Whisper 失败时退化到 Unscripted 作为兜底。Scripted 模式下 `EnableMiscue: true`，Azure 会标记 Omission/Insertion/Substitution——可以用来检测 Whisper 幻觉。

## 用户基本信息

- 编程水平"基础会一些"——代码要有注释，新概念要解释
- 中国大陆 + iPhone + Windows 开发环境
- 需要代理访问海外 API（Clash Verge 已装）
- 用户女朋友是真实用户，数据不能丢
- 偏好小步快跑、每步验证再推进（见 `~/.claude/projects/D--Claude-Programs-----/memory/feedback_workflow.md`）
