// 整句语调分析 API — 全套切到 Claude

import { ask } from "@/lib/llm";
import { checkAndIncrementQuota } from "@/lib/db";

type WordProsodyInput = {
  word: string;
  unexpectedBreak: boolean;
  missingBreak: boolean;
  breakLength: number;
  monotone: number;
};

export async function POST(request: Request) {
  try {
    // 防刷：和 analyze-word 共用配额，每天 300 次
    const allowed = await checkAndIncrementQuota("analysis", 300);
    if (!allowed) {
      return Response.json(
        { error: "今日分析次数已达上限，明天再来" },
        { status: 429 },
      );
    }

    const { sentence, prosodyScore, fluencyScore, words } =
      (await request.json()) as {
        sentence: string;
        prosodyScore: number;
        fluencyScore: number;
        words: WordProsodyInput[];
      };

    const wordReport = words
      .map((w) => {
        const issues: string[] = [];
        if (w.unexpectedBreak)
          issues.push(`意外停顿(${(w.breakLength * 1000).toFixed(0)}ms)`);
        if (w.missingBreak) issues.push("该停没停");
        if (w.monotone > 0.5)
          issues.push(`语调偏平(${(w.monotone * 100).toFixed(0)}%)`);
        return `  "${w.word}" → ${issues.length > 0 ? issues.join(", ") : "正常"}`;
      })
      .join("\n");

    const unexpectedBreaks = words.filter((w) => w.unexpectedBreak);
    const missingBreaks = words.filter((w) => w.missingBreak);
    const avgMonotone =
      words.length > 0
        ? words.reduce((s, w) => s + w.monotone, 0) / words.length
        : 0;

    const prompt = `用户刚说了这句话：

"${sentence}"

整句评分：
- Prosody（韵律/语调）：${prosodyScore}/100
- Fluency（流畅度）：${fluencyScore}/100

逐词韵律标记：
${wordReport}

统计：
- 意外停顿：${unexpectedBreaks.length} 处${unexpectedBreaks.length > 0 ? `（在 ${unexpectedBreaks.map((w) => `"${w.word}"`).join("、")} 前）` : ""}
- 缺少停顿：${missingBreaks.length} 处${missingBreaks.length > 0 ? `（在 ${missingBreaks.map((w) => `"${w.word}"`).join("、")} 前）` : ""}
- 整句单调度：${(avgMonotone * 100).toFixed(0)}%（越高越平，母语者通常 < 20%）

请用中文给出**整句层面**的语调分析，格式严格如下：

**整体评价**：（一句话总评。不要复述分数，直接说感觉，比如"节奏感不错但语调偏平"或"整体流畅，停顿位置合理"）

**停顿问题**：（如果有意外停顿或缺少停顿，指出具体在哪个词附近该怎么调整。如果没有停顿问题就说"停顿自然"。提示：句号和逗号处应有短停顿，介词/冠词和后面的名词之间不应停顿）

**语调建议**：（针对中国人常见的"平调"问题，给出这句话具体哪里该升调、哪里该降调。比如"疑问句末尾应该上扬"、"'morning'的第一个音节重读后应该有轻微下降"。用具体例子，别说套话）

**示范节奏**：（用大小写或符号标注这句话的重读和节奏，帮用户直观看到该怎么读。比如："GOOD MORning, how ARE you toDAY?" 其中大写=重读，小写=轻读）

注意：
- 全中文，紧凑不啰嗦
- 如果分数已经很高（90+），直接说"语调非常自然，继续保持"
- 示范节奏部分用英文原文标注`;

    const analysis = await ask(
      "你是一个为中文母语者设计的英语语调教练。",
      prompt,
    );

    return Response.json({ analysis });
  } catch (error) {
    console.error("Analyze-prosody API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
