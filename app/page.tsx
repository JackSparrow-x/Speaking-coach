"use client";

import { useState, useRef, useEffect } from "react";
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

// 对话消息
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  audioUrl?: string;
  pronunciation?: Pronunciation;
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
    };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setLoading(true);

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
      setMessages([...updatedMessages, aiMessage]);
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
  return (
    <div
      className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}
    >
      <div
        className={`max-w-[80%] flex flex-col gap-2 px-4 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-blue-500 text-white"
            : "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700"
        }`}
      >
        <div>{message.content}</div>
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
      {isUser && message.pronunciation && (
        <PronunciationCard
          data={message.pronunciation}
          sentence={message.content}
          audioUrl={message.audioUrl}
        />
      )}
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
      <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
        {loading && <span className="text-zinc-400">AI 分析中...</span>}
        {error && <span className="text-red-500">分析失败：{error}</span>}
        {analysis && <div>{analysis}</div>}
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
      <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
        {loading && <span className="text-zinc-400">AI 分析整句语调中...</span>}
        {error && <span className="text-red-500">分析失败：{error}</span>}
        {analysis && <div>{analysis}</div>}
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
