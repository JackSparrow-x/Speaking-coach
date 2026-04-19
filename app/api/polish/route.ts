// ========================================
// Polish API — 对用户的每句话做"地道性 + 进阶性"分析
// 不阻塞对话主流程，前端异步触发
// ========================================
//
// 输出结构严格约束为 JSON：
// {
//   color: "red" | "blue" | "gold",
//   fix: string | null,      // 明确语病才填（不要把"不够地道"当错误）
//   natural: string | null,  // 地道版（和原句有实质差异）
//   advanced: string | null, // 进阶版（和 natural 有实质差异）
//   praise: string | null,   // 仅 gold 时：说明原句好在哪（中文）
//   variant: string | null,  // 仅 gold 时：同级变体（可选）
// }
//
// 颜色判定（LLM 严格遵守）：
//   - red:  fix 非空（有明显语病）
//   - gold: 原句已达 advanced native 水平（很严，宁漏勿错）
//   - blue: 其他（没错但有 polish 可看）
// ========================================

import { ask } from "@/lib/llm";
import { checkAndIncrementQuota, savePolishRecord } from "@/lib/db";

export type PolishColor = "red" | "blue" | "gold";

export type PolishResult = {
  color: PolishColor;
  fix: string | null;
  natural: string | null;
  advanced: string | null;
  praise: string | null;
  variant: string | null;
};

export async function POST(request: Request) {
  try {
    // 防刷：每天最多 500 次（女朋友日常用大概 50 次上限，500 很宽松）
    const allowed = await checkAndIncrementQuota("polish", 500);
    if (!allowed) {
      return Response.json(
        { error: "今日 polish 次数已达上限，明天再来" },
        { status: 429 },
      );
    }

    const { sentence, recentContext, sessionId } = (await request.json()) as {
      sentence: string;
      recentContext?: string; // 最近 2-3 轮对话拼接的字符串，可选
      sessionId?: number | null;
    };

    if (!sentence || sentence.trim().length === 0) {
      return Response.json(
        { error: "缺少 sentence 字段" },
        { status: 400 },
      );
    }

    const contextBlock = recentContext
      ? `\n\nRecent conversation context (for judging what's "natural"):\n${recentContext}`
      : "";

    const system = `You are an English speaking coach for an intermediate Chinese learner. Your job is to give the user three things about each sentence they say: a fix (only if there's a real error), a natural native version, and an advanced native version. You return STRICTLY JSON, nothing else.`;

    const prompt = `Analyze this sentence the user just said in English conversation practice:

"${sentence}"${contextBlock}

Return a JSON object with these fields:
{
  "color": "red" | "blue" | "gold",
  "fix": string | null,
  "natural": string | null,
  "advanced": string | null,
  "praise": string | null,
  "variant": string | null
}

STRICT RULES — read carefully:

1) \`fix\` field — VERY HIGH BAR
   - Only fill \`fix\` if there is a GENUINE grammatical error, wrong word, or broken collocation.
   - "Not native enough" / "sounds a bit stiff" / "could be more casual" are NOT errors. Those belong in \`natural\`.
   - Examples that ARE fix-worthy: "I very like" (very can't modify verb), "He go to school" (subject-verb), "Yesterday I eat" (tense), "I am agree" (wrong structure).
   - Examples that are NOT fix-worthy: "The weather is very good today" (correct but not natural — use \`natural\`), "I want to eat food" (correct but plain — use \`natural\`).
   - Format: "original phrase → corrected phrase" (short, focused on the specific error, not a rewrite of the whole sentence).
   - If no genuine error: \`fix\` MUST be null.

2) \`natural\` field
   - How a native speaker would casually say the same idea.
   - Must be meaningfully DIFFERENT in wording from the original (different word choices, contractions, ellipsis — not just a typo fix).
   - If the original is already natural casual English: \`natural\` is null.

3) \`advanced\` field
   - A more expressive / idiomatic / sophisticated version using richer vocabulary, collocations, or phrasings. Still casual native register.
   - Must be meaningfully DIFFERENT from \`natural\` (different approach or vocab, not "natural + one synonym").
   - If no meaningful upgrade exists, or would feel forced: \`advanced\` is null.

4) \`color\` field — STRICT DETERMINATION
   - "red" if and only if \`fix\` is non-null.
   - "gold" ONLY IF the user's original sentence is ALREADY at advanced native level. Criteria: must satisfy at least 2 of these:
       (a) uses a non-textbook collocation or idiom (e.g. "swamped", "nail it", "call it a day", "I'm beat", "next-level")
       (b) casual native register with good ear (not stiff textbook English)
       (c) a B1-B2 Chinese learner would not typically think of this phrasing
     When in doubt between gold and blue, USE BLUE. Gold must be rare and deserved.
   - "blue" in all other cases.

5) GOLD-SPECIFIC RULES (critical)
   - When color is "gold":
     * \`fix\`, \`natural\`, \`advanced\`, \`variant\` MUST ALL be null. The user is already at advanced level — celebrate their achievement, don't offer alternatives.
     * \`praise\` is REQUIRED: 2-3 warm, specific Chinese sentences that (a) celebrate the achievement, (b) name the specific word or phrase that makes it good, (c) explain briefly why it's native-sounding. Tone should feel encouraging like a coach noticing a breakthrough, not clinical.
       Good praise example: "🎉 这句真地道！'swamped' 和 'grab lunch' 都是教科书里不会出现的上班族口语，节奏松弛不做作，完全是 native 的日常表达。敢这么说就是口语真正在进步。"
   - When color is "red" or "blue":
     * \`praise\` and \`variant\` MUST both be null.

6) Output format
   - Return ONLY the JSON object. No markdown fences, no \`\`\`json\`\`\`, no prose before or after.
   - All string values in English EXCEPT \`praise\` which is in Chinese.

Now analyze: "${sentence}"`;

    const rawResponse = await ask(system, prompt, "polish");

    // 解析 JSON（容错：Opus 有时会加 ```json``` 围栏，虽然 prompt 禁止了但保险起见清一下）
    const cleaned = rawResponse
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed: PolishResult;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("[polish] JSON parse failed:", cleaned);
      return Response.json(
        { error: "LLM 返回格式错误：" + (parseErr as Error).message, raw: cleaned },
        { status: 500 },
      );
    }

    // 简单校验：必要字段存在、color 合法
    if (!["red", "blue", "gold"].includes(parsed.color)) {
      return Response.json(
        { error: `LLM 返回非法 color: ${parsed.color}`, raw: cleaned },
        { status: 500 },
      );
    }

    // 一致性兜底（如果 LLM 没遵守规则，我们这边纠正）
    if (parsed.color === "red" && !parsed.fix) {
      // 说是红色但没给 fix → 降级成蓝色
      parsed.color = "blue";
    }
    if (parsed.fix && parsed.color !== "red") {
      // 给了 fix 但颜色没标红 → 强制标红
      parsed.color = "red";
    }
    if (parsed.color === "gold") {
      // Gold 严格：只有 praise，不该有 fix/natural/advanced/variant
      parsed.fix = null;
      parsed.natural = null;
      parsed.advanced = null;
      parsed.variant = null; // 用户明确要求：金点不再给变体，让自己开心就好
      // 没有 praise 的 gold 是无效的 → 降级成蓝色
      if (!parsed.praise) {
        parsed.color = "blue";
      }
    } else {
      // 非 gold：不该有 praise/variant
      parsed.praise = null;
      parsed.variant = null;
    }

    // 持久化到数据库（本地 dev 会 no-op 返回 null → 前端自动走本地收藏流程）
    const polishRecordId = await savePolishRecord({
      sessionId: sessionId ?? null,
      originalText: sentence,
      color: parsed.color,
      fix: parsed.fix,
      natural: parsed.natural,
      advanced: parsed.advanced,
      praise: parsed.praise,
      variant: parsed.variant,
    }).catch((err) => {
      console.error("[polish] 保存记录失败:", err);
      return null;
    });

    return Response.json({ ...parsed, polishRecordId });
  } catch (error) {
    console.error("Polish API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
