// 单词发音分析 API — 全套切到 Claude

import { ask } from "@/lib/llm";
import { checkAndIncrementQuota } from "@/lib/db";

type PhonemeInput = {
  phoneme: string;
  score: number;
};

export async function POST(request: Request) {
  try {
    // 防刷：和 analyze-prosody 共用配额，每天 300 次
    const allowed = await checkAndIncrementQuota("analysis", 300);
    if (!allowed) {
      return Response.json(
        { error: "今日分析次数已达上限，明天再来" },
        { status: 429 },
      );
    }

    const { word, phonemes, sentence, score } = (await request.json()) as {
      word: string;
      phonemes: PhonemeInput[];
      sentence: string;
      score: number;
    };

    if (!word || !phonemes) {
      return Response.json(
        { error: "缺少 word 或 phonemes" },
        { status: 400 },
      );
    }

    const phonemeReport = phonemes
      .map((p) => `  /${p.phoneme}/ → ${p.score}/100`)
      .join("\n");

    const weakPhonemes = phonemes
      .filter((p) => p.score < 80)
      .map((p) => `/${p.phoneme}/`)
      .join(", ");

    const prompt = `用户正在练习口语，刚才说了这句话：

"${sentence}"

其中单词 **"${word}"** 整体发音分 ${score}/100。该单词的音素级得分：
${phonemeReport}

${weakPhonemes ? `重点薄弱音素：${weakPhonemes}` : ""}

请你用中文给出一份**简短、具体、可操作**的发音建议，格式严格如下（不要加别的内容）：

**问题诊断**：（一句话说清楚最可能的错误模式。重点参考薄弱音素；如果整体分高就说"整体不错，稍注意某音"）

**发音要领**：（针对错误的音素，讲清楚舌位/唇形/气流。用 2-3 句话。写给中文母语者的直觉描述，不要用 IPA 术语，用"舌尖顶上下牙之间"这种具体描述）

**对比练习**：（给 1-2 对最小对立对单词帮助区分，比如 think/sink、bit/beat）

⚠️ 非常重要——关于连读和弱化的判断：
- 英语自然口语中，功能词（a, the, to, of, for, and, you, he, she, it, is, was, do, can, would 等）通常会弱读，比如 "to" 读成 /tə/ 而不是 /tuː/，"and" 读成 /ən/ 而不是 /ænd/。如果这些词分数低，**很可能是正常弱读而非发音错误**，请在诊断中说明"这是自然弱读，不需要纠正"。
- 在词与词衔接处（如 "good morning" 的 /d/），尾辅音被连读吃掉是正常的。如果某个词尾辅音音素分数很低（比如 0 分），但它后面紧跟另一个辅音开头的词，这通常是**正常连读**。请说明这一点。
- 只有当音素错误确实是发音问题（比如 /θ/ 发成 /s/、元音混淆）时，才给纠正建议。

注意：
- 别长篇大论，每部分尽量紧凑
- 别用英文，全中文
- 如果用户本身分数就高（90+）且没有明显薄弱音素，直接说"发音很好，继续保持"即可，不用编造问题
- 如果判断为正常连读/弱读导致的低分，直接说"这是正常语流现象，说明你的口语比较自然"，不要给纠正建议`;

    const analysis = await ask(
      "你是一个为中文母语者设计的英语发音教练。",
      prompt,
      "analyze-word",
    );

    return Response.json({ analysis });
  } catch (error) {
    console.error("Analyze-word API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
