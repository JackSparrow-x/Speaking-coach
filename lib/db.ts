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
    // Polish 记录：每次 LLM 分析用户一句话的结果
    `CREATE TABLE IF NOT EXISTS polish_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      original_text TEXT NOT NULL,
      color TEXT NOT NULL,
      fix TEXT,
      natural TEXT,
      advanced TEXT,
      praise TEXT,
      variant TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES conversation_sessions(id)
    )`,
    // 收藏夹：用户手动星标的表达（可以是 natural / advanced / variant / 原句）
    `CREATE TABLE IF NOT EXISTS favorite_expressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      polish_record_id INTEGER,
      text TEXT NOT NULL,
      source_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(polish_record_id, text, source_type),
      FOREIGN KEY (polish_record_id) REFERENCES polish_records(id)
    )`,
    // Token 使用统计（按 日期+endpoint+模型 聚合，每天最多几行）
    `CREATE TABLE IF NOT EXISTS token_usage (
      date TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      call_count INTEGER DEFAULT 0,
      PRIMARY KEY (date, endpoint, model)
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

// ========================================
// Polish & 收藏夹相关
// ========================================

export type PolishColor = "red" | "blue" | "gold";

/** 保存 polish 分析记录，返回自增 ID（本地 dev 返回 null）*/
export async function savePolishRecord(params: {
  sessionId: number | null;
  originalText: string;
  color: PolishColor;
  fix: string | null;
  natural: string | null;
  advanced: string | null;
  praise: string | null;
  variant: string | null;
}): Promise<number | null> {
  const db = getDb();
  if (!db) return null;

  const result = await db.execute({
    sql: `INSERT INTO polish_records
          (session_id, original_text, color, fix, natural, advanced, praise, variant)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      params.sessionId,
      params.originalText,
      params.color,
      params.fix,
      params.natural,
      params.advanced,
      params.praise,
      params.variant,
    ],
  });
  return Number(result.lastInsertRowid);
}

/**
 * 切换收藏状态：已收藏则删除，未收藏则新增
 * 返回最新状态 { favorited: true | false }
 */
export async function toggleFavorite(params: {
  polishRecordId: number;
  text: string;
  sourceType: "natural" | "advanced" | "variant" | "original";
}): Promise<{ favorited: boolean }> {
  const db = getDb();
  if (!db) {
    // 本地 dev：不持久化，但返回 true 让前端 UI 切换生效
    return { favorited: true };
  }

  // 先查是否已收藏
  const existing = await db.execute({
    sql: `SELECT id FROM favorite_expressions
          WHERE polish_record_id = ? AND text = ? AND source_type = ?`,
    args: [params.polishRecordId, params.text, params.sourceType],
  });

  if (existing.rows.length > 0) {
    // 已收藏 → 删除
    await db.execute({
      sql: "DELETE FROM favorite_expressions WHERE id = ?",
      args: [Number(existing.rows[0].id)],
    });
    return { favorited: false };
  } else {
    // 未收藏 → 新增
    await db.execute({
      sql: `INSERT INTO favorite_expressions (polish_record_id, text, source_type)
            VALUES (?, ?, ?)`,
      args: [params.polishRecordId, params.text, params.sourceType],
    });
    return { favorited: true };
  }
}

/** 列出所有收藏（给收藏夹页面用，Step 6）*/
export async function listFavorites(): Promise<
  {
    id: number;
    polishRecordId: number;
    text: string;
    sourceType: string;
    createdAt: string;
    originalText: string | null;
    color: string | null;
  }[]
> {
  const db = getDb();
  if (!db) return [];

  const result = await db.execute(
    `SELECT
       f.id, f.polish_record_id, f.text, f.source_type, f.created_at,
       p.original_text, p.color
     FROM favorite_expressions f
     LEFT JOIN polish_records p ON p.id = f.polish_record_id
     ORDER BY f.created_at DESC`,
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    polishRecordId: Number(row.polish_record_id),
    text: row.text as string,
    sourceType: row.source_type as string,
    createdAt: row.created_at as string,
    originalText: (row.original_text as string) ?? null,
    color: (row.color as string) ?? null,
  }));
}

// ========================================
// Token 用量追踪（按日期 × endpoint × 模型聚合）
// ========================================

/** 累加一次 LLM 调用的 token 用量（upsert）*/
export async function recordTokenUsage(params: {
  endpoint: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const db = getDb();
  if (!db) return;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await db.execute({
    sql: `INSERT INTO token_usage (date, endpoint, model, input_tokens, output_tokens, call_count)
          VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(date, endpoint, model) DO UPDATE SET
            input_tokens = input_tokens + ?,
            output_tokens = output_tokens + ?,
            call_count = call_count + 1`,
    args: [
      today,
      params.endpoint,
      params.model,
      params.inputTokens,
      params.outputTokens,
      params.inputTokens,
      params.outputTokens,
    ],
  });
}

/** 读取 token 用量统计（给 /api/stats 用）*/
export async function getTokenStats(): Promise<{
  today: {
    input: number;
    output: number;
    total: number;
    calls: number;
  };
  allTime: {
    input: number;
    output: number;
    total: number;
    calls: number;
  };
  byDay: {
    date: string;
    input: number;
    output: number;
    calls: number;
  }[];
  byEndpoint: {
    endpoint: string;
    model: string;
    input: number;
    output: number;
    calls: number;
  }[];
}> {
  const db = getDb();
  if (!db) {
    const empty = { input: 0, output: 0, total: 0, calls: 0 };
    return { today: empty, allTime: empty, byDay: [], byEndpoint: [] };
  }

  const today = new Date().toISOString().slice(0, 10);

  const [todayRow, totalRow, byDay, byEndpoint] = await Promise.all([
    db.execute({
      sql: `SELECT
              COALESCE(SUM(input_tokens),0) as input,
              COALESCE(SUM(output_tokens),0) as output,
              COALESCE(SUM(call_count),0) as calls
            FROM token_usage WHERE date = ?`,
      args: [today],
    }),
    db.execute(`SELECT
                  COALESCE(SUM(input_tokens),0) as input,
                  COALESCE(SUM(output_tokens),0) as output,
                  COALESCE(SUM(call_count),0) as calls
                FROM token_usage`),
    db.execute(`SELECT
                  date,
                  SUM(input_tokens) as input,
                  SUM(output_tokens) as output,
                  SUM(call_count) as calls
                FROM token_usage
                GROUP BY date
                ORDER BY date DESC
                LIMIT 30`),
    db.execute(`SELECT
                  endpoint, model,
                  SUM(input_tokens) as input,
                  SUM(output_tokens) as output,
                  SUM(call_count) as calls
                FROM token_usage
                GROUP BY endpoint, model
                ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`),
  ]);

  const todayData = {
    input: Number(todayRow.rows[0].input),
    output: Number(todayRow.rows[0].output),
    calls: Number(todayRow.rows[0].calls),
  };
  const totalData = {
    input: Number(totalRow.rows[0].input),
    output: Number(totalRow.rows[0].output),
    calls: Number(totalRow.rows[0].calls),
  };

  return {
    today: { ...todayData, total: todayData.input + todayData.output },
    allTime: { ...totalData, total: totalData.input + totalData.output },
    byDay: byDay.rows.map((r) => ({
      date: r.date as string,
      input: Number(r.input),
      output: Number(r.output),
      calls: Number(r.calls),
    })),
    byEndpoint: byEndpoint.rows.map((r) => ({
      endpoint: r.endpoint as string,
      model: r.model as string,
      input: Number(r.input),
      output: Number(r.output),
      calls: Number(r.calls),
    })),
  };
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
