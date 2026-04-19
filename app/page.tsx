"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { webmToWav } from "@/lib/audio-utils";
import {
  SCENARIOS,
  DEFAULT_SCENARIO_ID,
  getScenario,
  type Scenario,
} from "@/lib/scenarios";

// 录音状态
type RecordStatus = "idle" | "recording" | "transcribing";

// 发音评估结果
type Pronunciation = {
  scores: {
    accuracy: number;
    fluency: number;
    completeness: number;
    prosody: number | null;
    overall: number;
  };
  words: {
    word: string;
    score: number;
    errorType: string;
    offset: number;
    duration: number;
    phonemes: { phoneme: string; score: number }[];
    prosody: {
      unexpectedBreak: boolean;
      missingBreak: boolean;
      breakLength: number;
      monotone: number;
    };
  }[];
};

// Polish 结果（来自 /api/polish）
type PolishResult = {
  color: "red" | "blue" | "gold";
  fix: string | null;
  natural: string | null;
  advanced: string | null;
  praise: string | null;
  variant: string | null;
  polishRecordId: number | null; // 数据库主键，收藏 API 需要（本地 dev 时为 null）
};

// Polish 状态：加载中 / 失败 / 有结果 / 没触发（消息还没分析）
type PolishState = PolishResult | "loading" | "failed";

// 对话消息
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  audioUrl?: string;
  pronunciation?: Pronunciation;
  polish?: PolishState; // 仅用户消息会有，异步填充
};

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function synthesizeAndAttach(
  text: string,
  messageId: string,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) return;
    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, audioUrl } : m)),
    );
  } catch (err) {
    console.error("TTS error:", err);
  }
}

// 异步拉取 polish 分析并挂到对应消息上
// 不阻塞对话主流程：用户说完 → AI 回复先到 → polish 几秒后静默出现
async function fetchAndAttachPolish(
  messageId: string,
  sentence: string,
  recentContext: string,
  sessionId: number | null,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  try {
    const response = await fetch("/api/polish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence, recentContext, sessionId }),
    });
    if (!response.ok) {
      throw new Error(`polish ${response.status}`);
    }
    const data: PolishResult = await response.json();
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, polish: data } : m)),
    );
    console.log(
      `[polish] ${messageId.slice(0, 6)} color=${data.color}`,
      data,
    );
  } catch (err) {
    console.error("[polish] failed:", err);
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, polish: "failed" } : m)),
    );
  }
}

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center p-6 max-w-3xl mx-auto w-full">
      <header className="text-center mb-4">
        <h1 className="text-2xl font-semibold">
          英语口语陪练{" "}
          <span className="text-zinc-400 text-base font-normal">v0.4</span>
        </h1>
        <p className="text-xs text-zinc-500 mt-1">
          选个场景，按录音按钮说英文；点红色单词看发音建议
        </p>
        <Link
          href="/favorites"
          className="inline-block mt-2 text-xs text-zinc-500 hover:text-yellow-600 dark:hover:text-yellow-400"
        >
          ⭐ 收藏夹
        </Link>
      </header>
      <Conversation />
    </main>
  );
}

function Conversation() {
  // 当前场景
  const [scenarioId, setScenarioId] = useState<string>(DEFAULT_SCENARIO_ID);
  const scenario = getScenario(scenarioId);

  // 会话 ID（线上环境由后端返回，本地为 null）
  const sessionIdRef = useRef<number | null>(null);

  // 页面加载时创建会话
  useEffect(() => {
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId }),
    })
      .then((r) => r.json())
      .then((d) => {
        sessionIdRef.current = d.sessionId;
      })
      .catch(() => {}); // 失败静默（本地返回 null 也没事）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [recordStatus, setRecordStatus] = useState<RecordStatus>("idle");
  const [duration, setDuration] = useState(0);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const log = (msg: string) => {
    console.log("[debug]", msg);
    setDebugLog((prev) =>
      [
        ...prev.slice(-5),
        `${new Date().toLocaleTimeString()} ${msg}`,
      ].slice(-6),
    );
  };

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  // 切换场景：清空对话 + AI 自动说 greeting
  function switchScenario(newId: string) {
    if (newId === scenarioId) return;
    if (messages.length > 0) {
      const ok = confirm("切换场景会清空当前对话，继续吗？");
      if (!ok) return;
    }
    setScenarioId(newId);

    // 创建新会话（fire-and-forget）
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId: newId }),
    })
      .then((r) => r.json())
      .then((d) => {
        sessionIdRef.current = d.sessionId;
      })
      .catch(() => {});

    const newScenario = getScenario(newId);
    if (newScenario.greeting) {
      // AI 主动说第一句话（让用户知道"该怎么接"）
      const greetingMsg: Message = {
        id: makeId(),
        role: "assistant",
        content: newScenario.greeting,
      };
      setMessages([greetingMsg]);
      // TTS 播放 greeting
      synthesizeAndAttach(newScenario.greeting, greetingMsg.id, setMessages);
    } else {
      setMessages([]);
    }
  }

  async function sendMessage(
    content: string,
    audioUrl?: string,
    pronunciation?: Pronunciation,
  ) {
    if (!content.trim()) return;

    const userMessage: Message = {
      id: makeId(),
      role: "user",
      content,
      audioUrl,
      pronunciation,
      polish: "loading", // 先占位，polish 返回后替换
    };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setLoading(true);

    // 异步触发 polish（fire-and-forget）
    // 带最近 4 条消息作为上下文，帮 LLM 判断"什么是 natural"
    const recentContext = updatedMessages
      .slice(-4)
      .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
      .join("\n");
    fetchAndAttachPolish(
      userMessage.id,
      content,
      recentContext,
      sessionIdRef.current,
      setMessages,
    );

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages.map(({ role, content }) => ({
            role,
            content,
          })),
          scenarioId,
          sessionId: sessionIdRef.current, // 线上会传 number，本地传 null
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "请求失败");
      }
      const data = await response.json();

      const aiMessage: Message = {
        id: makeId(),
        role: "assistant",
        content: data.reply,
      };
      // 用函数式 setMessages，避免把 polish 返回的结果覆盖掉
      // （updatedMessages 是 closure 里的陈旧快照，不知道 polish 已经回来了）
      setMessages((prev) => [...prev, aiMessage]);
      synthesizeAndAttach(data.reply, aiMessage.id, setMessages);
    } catch (error) {
      alert("对话失败：" + (error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function startRecording() {
    log("Record tapped");
    try {
      if (!navigator.mediaDevices) {
        log("ERROR: no mediaDevices (insecure context?)");
        alert("当前环境不支持录音（非 HTTPS？）");
        return;
      }
      log("Requesting mic...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      log("Mic granted");

      let mimeType = "";
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported
      ) {
        if (MediaRecorder.isTypeSupported("audio/webm")) {
          mimeType = "audio/webm";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          mimeType = "audio/mp4";
        }
      }
      log(`Using mimeType: ${mimeType || "(default)"}`);
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        log("Recording stopped, packaging...");
        const blobType = mimeType || "audio/webm";
        const webmBlob = new Blob(chunksRef.current, { type: blobType });
        log(`Blob size: ${webmBlob.size} bytes, type: ${blobType}`);
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        await transcribeAndSend(webmBlob);
      };

      mediaRecorder.start();
      setRecordStatus("recording");
      setDuration(0);
      startTimeRef.current = Date.now();
      timerRef.current = window.setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 100);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      log(`ERROR: ${msg}`);
      alert("录音失败：" + msg);
    }
  }

  function stopRecording() {
    setRecordStatus("transcribing");
    mediaRecorderRef.current?.stop();
  }

  async function transcribeAndSend(webmBlob: Blob) {
    try {
      const wavBlob = await webmToWav(webmBlob);
      const formData = new FormData();
      formData.append("audio", wavBlob, "recording.wav");
      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "转录失败");
      }
      const data = await response.json();
      setRecordStatus("idle");

      // 调试：看当前评估模式
      if (data.mode) {
        console.log(
          `[模式] ${data.mode}${data.whisperFailed ? " (Whisper 失败退化)" : ""} → text: "${data.text}"`,
        );
      }

      if (!data.text) {
        alert(`没识别到内容：${data.hint || "请说长一点"}`);
        return;
      }
      const audioUrl = URL.createObjectURL(webmBlob);
      await sendMessage(data.text, audioUrl, data.pronunciation);
    } catch (error) {
      setRecordStatus("idle");
      alert("转录失败：" + (error as Error).message);
    }
  }

  const isBusy = loading || recordStatus !== "idle";

  return (
    <div className="flex flex-col gap-4 w-full flex-1">
      {/* 场景选择器 */}
      <ScenarioSelector
        current={scenario}
        onChange={switchScenario}
        disabled={isBusy}
      />

      {/* 消息列表 */}
      <div
        ref={listRef}
        className="flex flex-col gap-3 min-h-[400px] max-h-[500px] overflow-y-auto p-4 bg-zinc-50 dark:bg-zinc-900 rounded-xl"
      >
        {messages.length === 0 && (
          <div className="flex flex-col gap-2 text-zinc-400 text-sm text-center py-12">
            <div>
              <span className="font-medium text-zinc-600 dark:text-zinc-300">
                Scenario: {scenario.name}
              </span>
            </div>
            <div className="text-xs">{scenario.description}</div>
            {scenario.greeting && (
              <div className="mt-4 italic">
                &ldquo;{scenario.greeting}&rdquo;
              </div>
            )}
            <div className="mt-2 text-xs">Tap the mic to start.</div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="px-4 py-2 rounded-2xl bg-white dark:bg-zinc-800 text-zinc-500 text-sm border border-zinc-200 dark:border-zinc-700">
              Thinking...
            </div>
          </div>
        )}
      </div>

      {/* 录音按钮区 */}
      <div className="flex flex-col items-center gap-2">
        <div className="text-zinc-500 text-xs h-4">
          {recordStatus === "idle" && "Tap to record"}
          {recordStatus === "recording" && `Recording... ${duration}s`}
          {recordStatus === "transcribing" && "Transcribing..."}
        </div>
        <button
          onClick={
            recordStatus === "recording" ? stopRecording : startRecording
          }
          disabled={recordStatus === "transcribing" || loading}
          className={`
            w-20 h-20 rounded-full text-white font-medium text-xs
            transition-all shadow-md
            ${
              recordStatus === "recording"
                ? "bg-red-500 hover:bg-red-600 animate-pulse scale-110"
                : recordStatus === "transcribing" || loading
                  ? "bg-zinc-300 cursor-not-allowed"
                  : "bg-blue-500 hover:bg-blue-600 hover:scale-105"
            }
          `}
        >
          {recordStatus === "idle" && "Record"}
          {recordStatus === "recording" && "Stop"}
          {recordStatus === "transcribing" && "..."}
        </button>
      </div>

      {/* Debug 日志面板 */}
      {debugLog.length > 0 && (
        <div className="bg-black text-green-400 text-[11px] font-mono p-2 rounded-lg max-h-32 overflow-y-auto">
          {debugLog.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* 文字输入区 */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !isBusy) {
              e.preventDefault();
              const text = input;
              setInput("");
              sendMessage(text);
            }
          }}
          placeholder="Or type a message..."
          disabled={isBusy}
          className="flex-1 px-4 py-2 text-sm border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          onClick={() => {
            const text = input;
            setInput("");
            sendMessage(text);
          }}
          disabled={isBusy || !input.trim()}
          className="px-5 py-2 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ========================================
// 场景选择器
// ========================================
function ScenarioSelector({
  current,
  onChange,
  disabled,
}: {
  current: Scenario;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg">
      <label className="text-xs text-zinc-500 uppercase tracking-wide shrink-0">
        Scenario
      </label>
      <select
        value={current.id}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="flex-1 bg-transparent text-sm font-medium focus:outline-none disabled:opacity-50 cursor-pointer"
      >
        {SCENARIOS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <span className="hidden sm:block text-xs text-zinc-400 max-w-[40%] truncate">
        {current.description}
      </span>
    </div>
  );
}

// ========================================
// 消息气泡
// ========================================
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  // polish 面板展开状态（点击左侧小圆点切换）
  const [polishExpanded, setPolishExpanded] = useState(false);
  // polish 是"有结果"才允许展开（loading/failed/undefined 都不允许）
  const polishHasResult =
    message.polish &&
    message.polish !== "loading" &&
    message.polish !== "failed";
  return (
    <div
      className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}
    >
      <div className={`flex items-center gap-2 ${isUser ? "flex-row" : ""}`}>
        {/* 用户消息：在气泡左侧显示 polish 小圆点（Step 3）*/}
        {isUser && (
          <PolishDot
            polish={message.polish}
            active={polishExpanded}
            onClick={() => polishHasResult && setPolishExpanded((p) => !p)}
          />
        )}
        <div
          className={`max-w-[80%] flex flex-col gap-2 px-4 py-2 rounded-2xl text-sm leading-relaxed ${
            isUser
              ? "bg-blue-500 text-white"
              : "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700"
          }`}
        >
        {isUser ? (
          // 用户消息：纯文本（就是自己说的话，不需要 markdown）
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          // AI 消息：用 markdown 渲染（加粗、引用、列表等）
          <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_blockquote]:my-1 [&_strong]:font-semibold">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {message.audioUrl && (
          <audio
            key={message.audioUrl}
            src={message.audioUrl}
            controls
            autoPlay={!isUser}
            className="w-full h-8 mt-1 opacity-80"
          />
        )}
        </div>
      </div>
      {isUser && message.pronunciation && (
        <PronunciationCard
          data={message.pronunciation}
          sentence={message.content}
          audioUrl={message.audioUrl}
        />
      )}
      {/* Polish 展开面板：点了小圆点才显示 */}
      {isUser && polishExpanded && polishHasResult && (
        <PolishPanel
          polish={message.polish as PolishResult}
          originalText={message.content}
        />
      )}
    </div>
  );
}

// ========================================
// Polish 小圆点：气泡左侧的指示器（Step 3）
// 颜色约定：红=有语病、蓝=有地道/进阶版可看、金=原句已是 native 级
// ========================================
function PolishDot({
  polish,
  onClick,
  active,
}: {
  polish?: PolishState;
  onClick?: () => void;
  active?: boolean;
}) {
  // 没有 polish（AI 消息 / 刚切换场景）→ 不显示
  if (!polish) return null;

  // 失败也不显示（静默失败，不打扰用户）
  if (polish === "failed") return null;

  // 加载中：灰色小圆点 + 脉动动画
  if (polish === "loading") {
    return (
      <div
        className="w-2.5 h-2.5 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse"
        title="分析中..."
      />
    );
  }

  // 有结果：按 color 字段着色
  const colorClass =
    polish.color === "red"
      ? "bg-red-500"
      : polish.color === "gold"
        ? "bg-yellow-400"
        : "bg-blue-500";

  const titleMap = {
    red: "有语病 — 点击查看修正",
    blue: "有地道版/进阶版 — 点击查看",
    gold: "这句说得很棒 — 点击查看",
  };

  return (
    <button
      type="button"
      className={`w-3 h-3 rounded-full ${colorClass} cursor-pointer hover:scale-125 transition-transform shadow-sm ${
        active ? "ring-2 ring-offset-1 ring-gray-400" : ""
      }`}
      title={titleMap[polish.color]}
      onClick={onClick}
    />
  );
}

// ========================================
// Polish 展开面板（Step 4）：点击小圆点后显示的详情
// 根据 color 显示不同内容：
//   red: Fix + Natural + Advanced
//   blue: Natural + Advanced
//   gold: 原句鼓励 + 可选 Variant
// 每条地道/进阶版带 🔊 跟读和 ⭐ 收藏（收藏持久化留给 Step 5）
// ========================================
function PolishPanel({
  polish,
  originalText,
}: {
  polish: PolishResult;
  originalText: string;
}) {
  return (
    <div className="max-w-[80%] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl p-4 shadow-sm text-sm space-y-3">
      {/* 修正（红色场景）*/}
      {polish.fix && (
        <div>
          <div className="flex items-center gap-1 text-red-600 dark:text-red-400 font-medium text-xs mb-1">
            <span>⚠️</span>
            <span>修正</span>
          </div>
          <div className="text-zinc-800 dark:text-zinc-200">{polish.fix}</div>
        </div>
      )}

      {/* 地道版 */}
      {polish.natural && (
        <PolishLine
          icon="🗣️"
          label="地道版"
          labelColor="text-blue-600 dark:text-blue-400"
          text={polish.natural}
          polishRecordId={polish.polishRecordId}
          sourceType="natural"
        />
      )}

      {/* 进阶版 */}
      {polish.advanced && (
        <PolishLine
          icon="🚀"
          label="进阶版"
          labelColor="text-indigo-600 dark:text-indigo-400"
          text={polish.advanced}
          polishRecordId={polish.polishRecordId}
          sourceType="advanced"
        />
      )}

      {/* Gold 场景：赞美 + 原句收藏 */}
      {polish.praise && (
        <div>
          <div className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400 font-medium text-xs mb-1">
            <span>⭐</span>
            <span>点评</span>
          </div>
          <div className="text-zinc-800 dark:text-zinc-200 leading-relaxed">
            {polish.praise}
          </div>
          {/* 原句可收藏（Gold 时给用户一个爽点）*/}
          <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-700">
            <div className="text-xs text-zinc-500 mb-1">🎯 原句（建议收藏）</div>
            <PolishLine
              icon=""
              label=""
              labelColor=""
              text={originalText}
              hideHeader
              polishRecordId={polish.polishRecordId}
              sourceType="original"
            />
          </div>
        </div>
      )}

    </div>
  );
}

// Polish 面板里的一行：文本 + 🔊 + ⭐
function PolishLine({
  icon,
  label,
  labelColor,
  text,
  hideHeader,
  polishRecordId,
  sourceType,
}: {
  icon: string;
  label: string;
  labelColor: string;
  text: string;
  hideHeader?: boolean;
  polishRecordId: number | null; // 为 null 表示本地 dev（后端没存）
  sourceType: "natural" | "advanced" | "variant" | "original";
}) {
  const [playing, setPlaying] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [saving, setSaving] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function playTTS() {
    // 已经有 audio 对象就直接播
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      return;
    }
    setPlaying(true);
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error("TTS failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      audio.play();
    } catch (err) {
      console.error("[polish TTS]", err);
      setPlaying(false);
    }
  }

  async function toggleFavorite() {
    if (saving) return;

    // 本地 dev 下 polishRecordId 为 null（后端没存库），只做 UI 切换
    if (polishRecordId === null) {
      setFavorited((prev) => !prev);
      console.log(
        `[polish favorite local-only]${favorited ? " unfav" : " fav"}: "${text}"`,
      );
      return;
    }

    // 乐观更新（先切 UI，错了再回滚）
    const prevState = favorited;
    setFavorited(!prevState);
    setSaving(true);

    try {
      const response = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ polishRecordId, text, sourceType }),
      });
      if (!response.ok) throw new Error(`收藏失败 ${response.status}`);
      const data = (await response.json()) as { favorited: boolean };
      // 以后端返回为准（应付并发场景）
      setFavorited(data.favorited);
    } catch (err) {
      console.error("[polish favorite] API 失败，回滚 UI:", err);
      setFavorited(prevState); // 回滚
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {!hideHeader && (
        <div className={`flex items-center gap-1 font-medium text-xs mb-1 ${labelColor}`}>
          <span>{icon}</span>
          <span>{label}</span>
        </div>
      )}
      <div className="flex items-start gap-2">
        <div className="flex-1 text-zinc-800 dark:text-zinc-200">{text}</div>
        <button
          type="button"
          onClick={playTTS}
          disabled={playing}
          className="shrink-0 px-2 py-0.5 text-xs rounded border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-50"
          title="跟读"
        >
          🔊
        </button>
        <button
          type="button"
          onClick={toggleFavorite}
          className={`shrink-0 px-2 py-0.5 text-xs rounded border transition-colors ${
            favorited
              ? "border-yellow-300 bg-yellow-50 dark:bg-yellow-900/30 text-yellow-600"
              : "border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700"
          }`}
          title={favorited ? "已收藏" : "收藏"}
        >
          {favorited ? "⭐" : "☆"}
        </button>
      </div>
    </div>
  );
}

// ========================================
// 发音评估卡片（含单词点击展开）
// ========================================
// 展开状态：可以展开一个单词，或展开整句 Prosody 分析
type DetailView =
  | { type: "word"; index: number }
  | { type: "prosody" }
  | null;

function PronunciationCard({
  data,
  sentence,
  audioUrl,
}: {
  data: Pronunciation;
  sentence: string;
  audioUrl?: string;
}) {
  const [detailView, setDetailView] = useState<DetailView>(null);

  const selectedWord =
    detailView?.type === "word" ? data.words[detailView.index] : null;

  function onWordClick(i: number) {
    setDetailView((prev) =>
      prev?.type === "word" && prev.index === i
        ? null
        : { type: "word", index: i },
    );
  }

  function onProsodyClick() {
    setDetailView((prev) =>
      prev?.type === "prosody" ? null : { type: "prosody" },
    );
  }

  return (
    <div className="max-w-[80%] bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3 flex flex-col gap-3">
      <div className="grid grid-cols-5 gap-2 text-center">
        <ScoreCell label="Overall" score={data.scores.overall} highlight />
        <ScoreCell label="Accuracy" score={data.scores.accuracy} />
        <ScoreCell label="Fluency" score={data.scores.fluency} />
        {/* Prosody 可点击展开整句分析 */}
        <button
          onClick={onProsodyClick}
          className={`flex flex-col items-center transition-all rounded-lg p-1 ${
            detailView?.type === "prosody"
              ? "ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20"
              : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
          title="点击查看整句语调分析"
        >
          <div
            className={`font-semibold text-lg ${data.scores.prosody !== null ? scoreColor(data.scores.prosody) : "text-zinc-300"}`}
          >
            {data.scores.prosody !== null
              ? Math.round(data.scores.prosody)
              : "-"}
          </div>
          <div className="text-[10px] text-zinc-400 uppercase tracking-wide">
            Prosody
          </div>
        </button>
        <ScoreCell label="Complete" score={data.scores.completeness} />
      </div>

      {data.words.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-zinc-200 dark:border-zinc-800">
          {data.words.map((w, i) => (
            <WordChip
              key={i}
              word={w.word}
              score={w.score}
              selected={detailView?.type === "word" && detailView.index === i}
              onClick={() => onWordClick(i)}
            />
          ))}
        </div>
      )}

      {/* 单词详情 */}
      {selectedWord && (
        <WordDetail
          word={selectedWord.word}
          score={selectedWord.score}
          phonemes={selectedWord.phonemes}
          sentence={sentence}
          offset={selectedWord.offset}
          duration={selectedWord.duration}
          audioUrl={audioUrl}
        />
      )}

      {/* 整句语调分析 */}
      {detailView?.type === "prosody" && (
        <ProsodyDetail
          sentence={sentence}
          prosodyScore={data.scores.prosody ?? 0}
          fluencyScore={data.scores.fluency}
          words={data.words}
        />
      )}
    </div>
  );
}

function ScoreCell({
  label,
  score,
  highlight,
}: {
  label: string;
  score: number | null;
  highlight?: boolean;
}) {
  if (score === null) {
    return (
      <div className="flex flex-col items-center">
        <div className="text-lg font-semibold text-zinc-300">-</div>
        <div className="text-[10px] text-zinc-400 uppercase tracking-wide">
          {label}
        </div>
      </div>
    );
  }
  const color = scoreColor(score);
  return (
    <div className="flex flex-col items-center">
      <div
        className={`font-semibold ${color} ${highlight ? "text-2xl" : "text-lg"}`}
      >
        {Math.round(score)}
      </div>
      <div className="text-[10px] text-zinc-400 uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
}

function WordChip({
  word,
  score,
  selected,
  onClick,
}: {
  word: string;
  score: number;
  selected: boolean;
  onClick: () => void;
}) {
  const bg = scoreBg(score);
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-xs rounded-md font-medium transition-all ${bg} ${
        selected
          ? "ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-zinc-900"
          : "hover:opacity-80"
      }`}
      title={`${word}: ${Math.round(score)}`}
    >
      {word}
    </button>
  );
}

// ========================================
// 单词详情：显示音素分数 + LLM 解读
// ========================================
function WordDetail({
  word,
  score,
  phonemes,
  sentence,
  offset,
  duration,
  audioUrl,
}: {
  word: string;
  score: number;
  phonemes: { phoneme: string; score: number }[];
  sentence: string;
  offset: number; // 秒
  duration: number; // 秒
  audioUrl?: string; // 用户原始录音
}) {
  const [analysis, setAnalysis] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [playingMy, setPlayingMy] = useState(false);
  const [playingStd, setPlayingStd] = useState(false);

  // 切换到这个词时懒加载 LLM 解读
  useEffect(() => {
    let cancelled = false;

    async function fetchAnalysis() {
      setLoading(true);
      setError("");
      setAnalysis("");
      try {
        const res = await fetch("/api/analyze-word", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ word, score, phonemes, sentence }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "分析失败");
        }
        const data = await res.json();
        if (!cancelled) setAnalysis(data.analysis);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAnalysis();
    return () => {
      cancelled = true;
    };
  }, [word, score, phonemes, sentence]);

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
      {/* 单词标题 */}
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold">{word}</span>
        <span className={`text-sm font-medium ${scoreColor(score)}`}>
          {Math.round(score)}
        </span>
      </div>

      {/* 发音对比：听我的 vs 标准 */}
      <div className="flex gap-2">
        {audioUrl && duration > 0 && (
          <button
            onClick={() => {
              setPlayingMy(true);
              const audio = new Audio(audioUrl);
              audio.currentTime = offset;
              audio.play();
              // 播放 duration 秒后暂停
              setTimeout(() => {
                audio.pause();
                setPlayingMy(false);
              }, duration * 1000 + 100); // 多 100ms 容差
            }}
            disabled={playingMy}
            className="px-3 py-1 text-xs bg-zinc-200 dark:bg-zinc-700 rounded-md hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50"
          >
            {playingMy ? "..." : "My pronunciation"}
          </button>
        )}
        <button
          onClick={async () => {
            setPlayingStd(true);
            try {
              const res = await fetch("/api/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: word }),
              });
              if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.onended = () => {
                  setPlayingStd(false);
                  URL.revokeObjectURL(url);
                };
                audio.play();
              } else {
                setPlayingStd(false);
              }
            } catch {
              setPlayingStd(false);
            }
          }}
          disabled={playingStd}
          className="px-3 py-1 text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded-md hover:bg-blue-200 dark:hover:bg-blue-800/40 disabled:opacity-50"
        >
          {playingStd ? "..." : "Standard pronunciation"}
        </button>
      </div>

      {/* 音素级分数 */}
      <div className="flex flex-wrap gap-1">
        {phonemes.map((p, i) => (
          <span
            key={i}
            className={`px-1.5 py-0.5 text-[11px] font-mono rounded ${scoreBg(p.score)}`}
            title={`/${p.phoneme}/: ${Math.round(p.score)}`}
          >
            /{p.phoneme}/ {Math.round(p.score)}
          </span>
        ))}
      </div>

      {/* LLM 解读 */}
      <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        {loading && <span className="text-zinc-400">AI 分析中...</span>}
        {error && <span className="text-red-500">分析失败：{error}</span>}
        {analysis && (
          <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:my-1 [&_strong]:font-semibold [&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-2 [&_blockquote]:text-zinc-600">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {analysis}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// ========================================
// 整句语调分析（点 Prosody 分数展开）
// ========================================
function ProsodyDetail({
  sentence,
  prosodyScore,
  fluencyScore,
  words,
}: {
  sentence: string;
  prosodyScore: number;
  fluencyScore: number;
  words: Pronunciation["words"];
}) {
  const [analysis, setAnalysis] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [playingStd, setPlayingStd] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchAnalysis() {
      setLoading(true);
      setError("");
      setAnalysis("");
      try {
        const res = await fetch("/api/analyze-prosody", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sentence,
            prosodyScore,
            fluencyScore,
            words: words.map((w) => ({
              word: w.word,
              ...w.prosody,
            })),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "分析失败");
        }
        const data = await res.json();
        if (!cancelled) setAnalysis(data.analysis);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAnalysis();
    return () => {
      cancelled = true;
    };
  }, [sentence, prosodyScore, fluencyScore, words]);

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold">Sentence Prosody</span>
        <span className={`text-sm font-medium ${scoreColor(prosodyScore)}`}>
          {Math.round(prosodyScore)}
        </span>
      </div>

      {/* 标准语调播放（用户自己的录音在气泡里已经有了） */}
      <div>
        <button
          onClick={async () => {
            setPlayingStd(true);
            try {
              const res = await fetch("/api/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: sentence }),
              });
              if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.onended = () => {
                  setPlayingStd(false);
                  URL.revokeObjectURL(url);
                };
                audio.play();
              } else {
                setPlayingStd(false);
              }
            } catch {
              setPlayingStd(false);
            }
          }}
          disabled={playingStd}
          className="px-3 py-1.5 text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded-md hover:bg-blue-200 dark:hover:bg-blue-800/40 disabled:opacity-50"
        >
          {playingStd ? "Playing..." : "Listen to standard intonation"}
        </button>
      </div>

      {/* 逐词韵律标记（可视化） */}
      <div className="flex flex-wrap gap-1">
        {words.map((w, i) => {
          const issues: string[] = [];
          if (w.prosody.unexpectedBreak) issues.push("pause");
          if (w.prosody.missingBreak) issues.push("no-pause");
          return (
            <span
              key={i}
              className={`px-1.5 py-0.5 text-[11px] rounded ${
                issues.length > 0
                  ? "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
              title={issues.length > 0 ? issues.join(", ") : "OK"}
            >
              {w.word}
              {issues.length > 0 && (
                <span className="ml-0.5 text-orange-500">*</span>
              )}
            </span>
          );
        })}
      </div>

      {/* LLM 整句分析 */}
      <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        {loading && <span className="text-zinc-400">AI 分析整句语调中...</span>}
        {error && <span className="text-red-500">分析失败：{error}</span>}
        {analysis && (
          <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:my-1 [&_strong]:font-semibold [&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-2 [&_blockquote]:text-zinc-600">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {analysis}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function scoreColor(score: number) {
  if (score >= 90) return "text-green-600 dark:text-green-400";
  if (score >= 75) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}
function scoreBg(score: number) {
  if (score >= 90)
    return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (score >= 75)
    return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
}
