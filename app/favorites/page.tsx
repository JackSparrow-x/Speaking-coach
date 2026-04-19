// ========================================
// 收藏夹页面（/favorites）
// 列出用户收藏的所有表达，按时间倒序
// 每条卡片：来源标签 + 文本 + 🔊 跟读 + 原句参照 + 取消收藏
// ========================================

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type FavoriteItem = {
  id: number;
  polishRecordId: number;
  text: string;
  sourceType: "natural" | "advanced" | "variant" | "original";
  createdAt: string;
  originalText: string | null;
  color: string | null;
};

// 来源类型的展示样式
const SOURCE_META: Record<
  FavoriteItem["sourceType"],
  { icon: string; label: string; className: string }
> = {
  natural: {
    icon: "🗣️",
    label: "地道版",
    className: "text-blue-600 dark:text-blue-400",
  },
  advanced: {
    icon: "🚀",
    label: "进阶版",
    className: "text-indigo-600 dark:text-indigo-400",
  },
  variant: {
    icon: "💡",
    label: "同级变体",
    className: "text-amber-600 dark:text-amber-400",
  },
  original: {
    icon: "🎯",
    label: "你自己说的",
    className: "text-yellow-600 dark:text-yellow-400",
  },
};

export default function FavoritesPage() {
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/favorites")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setFavorites(data.favorites || []);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // 用户点了某条的"取消收藏"按钮 → 从列表里移除
  function handleRemoved(id: number) {
    setFavorites((prev) => prev.filter((f) => f.id !== id));
  }

  return (
    <main className="flex flex-1 flex-col items-center p-6 max-w-3xl mx-auto w-full">
      <header className="w-full flex items-center justify-between mb-6">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← 返回对话
        </Link>
        <h1 className="text-xl font-semibold">⭐ 收藏夹</h1>
        <div className="w-16" />
      </header>

      {loading && (
        <div className="text-zinc-500 text-sm py-12">加载中...</div>
      )}

      {!loading && error && (
        <div className="text-red-500 text-sm py-12">
          加载失败：{error}
        </div>
      )}

      {!loading && !error && favorites.length === 0 && (
        <div className="text-center text-zinc-500 text-sm py-20">
          <div className="text-3xl mb-3">📒</div>
          <div>还没有收藏任何表达</div>
          <div className="text-xs mt-2">
            在对话里点气泡旁的小圆点 → 点击每条建议旁的 ⭐ 就可以收藏
          </div>
        </div>
      )}

      {!loading && !error && favorites.length > 0 && (
        <div className="w-full space-y-3">
          {favorites.map((f) => (
            <FavoriteCard
              key={f.id}
              item={f}
              onRemoved={() => handleRemoved(f.id)}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function FavoriteCard({
  item,
  onRemoved,
}: {
  item: FavoriteItem;
  onRemoved: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const meta = SOURCE_META[item.sourceType];

  async function playTTS() {
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
        body: JSON.stringify({ text: item.text }),
      });
      if (!response.ok) throw new Error("TTS failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      audio.play();
    } catch (err) {
      console.error("[favorites TTS]", err);
      setPlaying(false);
    }
  }

  async function handleRemove() {
    if (removing) return;
    const confirmed = confirm(`从收藏夹移除这条？\n\n"${item.text}"`);
    if (!confirmed) return;

    setRemoving(true);
    try {
      // 复用 toggle 接口：再 toggle 一次等于取消
      const response = await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          polishRecordId: item.polishRecordId,
          text: item.text,
          sourceType: item.sourceType,
        }),
      });
      if (!response.ok) throw new Error(`取消失败 ${response.status}`);
      onRemoved();
    } catch (err) {
      console.error("[favorites remove]", err);
      alert("取消收藏失败：" + (err as Error).message);
      setRemoving(false);
    }
  }

  // 日期格式化：2026-04-20 13:45
  const dateDisplay = item.createdAt
    ? item.createdAt.replace("T", " ").slice(0, 16)
    : "";

  return (
    <div className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl p-4 shadow-sm">
      <div className="flex items-center justify-between text-xs mb-2">
        <span className={`font-medium ${meta.className}`}>
          {meta.icon} {meta.label}
        </span>
        <span className="text-zinc-400">{dateDisplay}</span>
      </div>

      <div className="flex items-start gap-2 mb-2">
        <div className="flex-1 text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
          {item.text}
        </div>
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
          onClick={handleRemove}
          disabled={removing}
          className="shrink-0 px-2 py-0.5 text-xs rounded border border-zinc-200 dark:border-zinc-600 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-200 dark:hover:border-red-700 disabled:opacity-50"
          title="取消收藏"
        >
          {removing ? "..." : "✕"}
        </button>
      </div>

      {/* 原句对比：让用户记得"我当时是怎么说的" */}
      {item.originalText && item.sourceType !== "original" && (
        <div className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-700">
          <div className="text-xs text-zinc-500 mb-1">你当时的原话</div>
          <div className="text-xs text-zinc-600 dark:text-zinc-400 italic">
            {item.originalText}
          </div>
        </div>
      )}
    </div>
  );
}
