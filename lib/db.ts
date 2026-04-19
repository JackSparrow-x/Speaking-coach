// ========================================
// 数据层：Turso（SQLite 云版）
//
// 核心规则：
// - NODE_ENV === "production"（Vercel 线上）→ 正常连 Turso 读写
// - NODE_ENV !== "production"（本地 dev）→ 所有函数静默跳过，不报错
// - 这样本地开发不会污染数据库
// ========================================

import { createClient, type Client } from "@libsql/client";

// 数据库单例（避免每次请求都建新连接）
let _db: Client | null = null;

function getDb(): Client | null {
  // 本地开发不连数据库
  if (process.env.NODE_ENV !== "production") return null;

  if (!_db) {
    const url = process.env.TURSO_DB_URL;
    const authToken = process.env.TURSO_DB_TOKEN;
    if (!url || !authToken) {
      console.error("[db] TURSO_DB_URL 或 TURSO_DB_TOKEN 未配置");
      return null;
    }
    _db = createClient({ url, authToken });
    // 首次连接自动建表
    initTables(_db).catch((err) => console.error("[db] 建表失败:", err));
  }
  return _db;
}

// ========================================
// 建表（CREATE IF NOT EXISTS，可重复执行）
// ========================================
async function initTables(db: Client) {
  await db.batch([
    // 发音评估记录
    `CREATE TABLE IF NOT EXISTS pronunciation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      sentence TEXT NOT NULL,
      overall_score REAL,
      accuracy_score REAL,
      fluency_score REAL,
      prosody_score REAL,
      completeness_score REAL,
      word_details TEXT
    )`,
    // 弱点音素统计
    `CREATE TABLE IF NOT EXISTS weak_phonemes (
      phoneme TEXT PRIMARY KEY,
      error_count INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      avg_score REAL DEFAULT 0,
      last_seen_at TEXT DEFAULT (datetime('now'))
    )`,
    // 单词本
    `CREATE TABLE IF NOT EXISTS vocabulary (
      word TEXT PRIMARY KEY,
      source_sentence TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      review_count INTEGER DEFAULT 0,
      next_review_at TEXT,
      accuracy_score REAL
    )`,
    // 对话会话
    `CREATE TABLE IF NOT EXISTS conversation_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      last_message_at TEXT,
      message_count INTEGER DEFAULT 0,
      summary TEXT,
      last_summary_at TEXT
    )`,
    // 对话消息
    `CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES conversation_sessions(id)
    )`,
    // 每日调用计数（防刷）
    `CREATE TABLE IF NOT EXISTS usage_counter (
      date TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (date, endpoint)
    )`,
  ]);
  console.log("[db] 表初始化完成");
}

// ========================================
// 配额检查（防 API 被刷爆）
// 本地开发不限（返回 true）
// 线上：每天每个 endpoint 各自的上限
// ========================================
export async function checkAndIncrementQuota(
  endpoint: string,
  dailyLimit: number,
): Promise<boolean> {
  const db = getDb();
  if (!db) return true; // 本地不限

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 原子 upsert：插入或累加，返回最新 count
  const result = await db.execute({
    sql: `INSERT INTO usage_counter (date, endpoint, count)
          VALUES (?, ?, 1)
          ON CONFLICT(date, endpoint) DO UPDATE SET count = count + 1
          RETURNING count`,
    args: [today, endpoint],
  });

  const count = Number(result.rows[0].count);
  return count <= dailyLimit;
}

// ========================================
// 写入函数（全部有 guard，本地静默跳过）
// ========================================

/** 创建新的对话会话，返回 sessionId */
export async function createSession(
  scenarioId: string,
): Promise<number | null> {
  const db = getDb();
  if (!db) return null;

  const result = await db.execute({
    sql: "INSERT INTO conversation_sessions (scenario_id) VALUES (?)",
    args: [scenarioId],
  });
  return Number(result.lastInsertRowid);
}

/** 保存一条对话消息 */
export async function saveMessage(
  sessionId: number | null,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  const db = getDb();
  if (!db || !sessionId) return;

  await db.batch([
    {
      sql: "INSERT INTO conversation_messages (session_id, role, content) VALUES (?, ?, ?)",
      args: [sessionId, role, content],
    },
    {
      sql: `UPDATE conversation_sessions
            SET message_count = message_count + 1,
                last_message_at = datetime('now')
            WHERE id = ?`,
      args: [sessionId],
    },
  ]);
}

/** 保存发音评估记录 + 更新弱点音素 + 自动收纳低分词 */
export async function savePronunciationRecord(
  sentence: string,
  scores: {
    overall: number;
    accuracy: number;
    fluency: number;
    prosody: number | null;
    completeness: number;
  },
  words: {
    word: string;
    score: number;
    phonemes: { phoneme: string; score: number }[];
  }[],
): Promise<void> {
  const db = getDb();
  if (!db) return;

  // 1. 保存整句记录
  await db.execute({
    sql: `INSERT INTO pronunciation_records
          (sentence, overall_score, accuracy_score, fluency_score, prosody_score, completeness_score, word_details)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sentence,
      scores.overall,
      scores.accuracy,
      scores.fluency,
      scores.prosody,
      scores.completeness,
      JSON.stringify(words),
    ],
  });

  // 2. 更新弱点音素统计
  for (const word of words) {
    for (const phoneme of word.phonemes) {
      await db.execute({
        sql: `INSERT INTO weak_phonemes (phoneme, error_count, total_count, avg_score, last_seen_at)
              VALUES (?, ?, 1, ?, datetime('now'))
              ON CONFLICT(phoneme) DO UPDATE SET
                error_count = CASE WHEN ? < 75 THEN error_count + 1 ELSE error_count END,
                total_count = total_count + 1,
                avg_score = (avg_score * total_count + ?) / (total_count + 1),
                last_seen_at = datetime('now')`,
        args: [
          phoneme.phoneme,
          phoneme.score < 75 ? 1 : 0,
          phoneme.score,
          phoneme.score,
          phoneme.score,
        ],
      });
    }
  }

  // 3. 低分词自动加入单词本（< 80 分的词）
  for (const word of words) {
    if (word.score < 80) {
      await db.execute({
        sql: `INSERT INTO vocabulary (word, source_sentence, accuracy_score)
              VALUES (?, ?, ?)
              ON CONFLICT(word) DO UPDATE SET
                accuracy_score = ?,
                source_sentence = ?`,
        args: [word.word, sentence, word.score, word.score, sentence],
      });
    }
  }
}

/** 检查是否该生成总结（≥10 条消息 AND ≥30 分钟） */
export async function shouldSummarize(
  sessionId: number | null,
): Promise<boolean> {
  const db = getDb();
  if (!db || !sessionId) return false;

  const result = await db.execute({
    sql: `SELECT message_count, started_at, last_summary_at
          FROM conversation_sessions WHERE id = ?`,
    args: [sessionId],
  });

  if (result.rows.length === 0) return false;
  const row = result.rows[0];
  const messageCount = Number(row.message_count);
  const startedAt = new Date(row.started_at as string).getTime();
  const lastSummaryAt = row.last_summary_at
    ? new Date(row.last_summary_at as string).getTime()
    : 0;
  const now = Date.now();

  // 距上次总结 ≥10 条消息
  const messagesSinceLastSummary = lastSummaryAt
    ? messageCount // 简化：用总数
    : messageCount;

  // 距开始 ≥30 分钟
  const minutesSinceStart = (now - startedAt) / 60000;

  return messagesSinceLastSummary >= 10 && minutesSinceStart >= 30;
}

/** 保存对话总结 */
export async function saveSummary(
  sessionId: number | null,
  summary: string,
): Promise<void> {
  const db = getDb();
  if (!db || !sessionId) return;

  await db.execute({
    sql: `UPDATE conversation_sessions
          SET summary = ?, last_summary_at = datetime('now')
          WHERE id = ?`,
    args: [summary, sessionId],
  });
}

/** 获取最近的未总结会话（下次打开时用） */
export async function getLastUnsummarizedSession(): Promise<{
  id: number;
  scenarioId: string;
  messageCount: number;
  startedAt: string;
} | null> {
  const db = getDb();
  if (!db) return null;

  const result = await db.execute(
    `SELECT id, scenario_id, message_count, started_at
     FROM conversation_sessions
     WHERE summary IS NULL AND message_count >= 10
     ORDER BY started_at DESC LIMIT 1`,
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: Number(row.id),
    scenarioId: row.scenario_id as string,
    messageCount: Number(row.message_count),
    startedAt: row.started_at as string,
  };
}
