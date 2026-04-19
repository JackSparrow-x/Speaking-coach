// ========================================
// 后端转录 + 发音评估 API
// 一次调用拿到两样东西：
//   1. 识别出的文字（transcript）
//   2. 发音评分（accuracy / fluency / prosody / 单词级 / 音素级）
// 关键：Azure 把发音评估作为 STT 的扩展功能，靠一个特殊 header 启用
// ========================================

import { savePronunciationRecord, checkAndIncrementQuota } from "@/lib/db";
import { transcribeWithWhisper } from "@/lib/whisper";

export async function POST(request: Request) {
  try {
    // 防刷：每天最多 200 次
    const allowed = await checkAndIncrementQuota("transcribe", 200);
    if (!allowed) {
      return Response.json(
        { error: "今日录音次数已达上限，明天再来" },
        { status: 429 },
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get("audio") as File | null;

    if (!audioFile) {
      return Response.json({ error: "缺少 audio 字段" }, { status: 400 });
    }

    const audioBuffer = await audioFile.arrayBuffer();

    const region = process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY;

    if (!region || !key) {
      return Response.json(
        { error: "Azure Speech 环境变量未配置" },
        { status: 500 },
      );
    }

    // format=detailed：让 Azure 返回 NBest 详细数组（发音评分在这里面）
    const endpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

    // ========================================
    // 新流程（串行）：先 Whisper 拿准确转录 → 再用 Whisper 文本作为 Azure Scripted 参考
    // 为什么要换：之前并行时 Azure 和 Whisper 分别识别，Azure 的发音评分是给"Azure 识别的词"打的
    // 但 Azure 识别中国口音英语常出错（比如把 think 听成 sink、把 trying 听成 a trying），
    // 导致词语标签里出现 i'm 等用户根本没说的词，总分也是错的。
    // 改成 Scripted 模式后，Azure 按 Whisper 给的文本逐词对齐打分，词语标签 = 气泡文本，一致了。
    // 代价：多 1-2 秒延迟（串行而非并行），但评分终于有意义。
    // ========================================

    // Step 1: 先跑 Whisper 拿准确转录
    let whisperText: string | null = null;
    let whisperError: Error | null = null;
    try {
      const whisperResult = await transcribeWithWhisper(audioBuffer, "recording.wav");
      whisperText = whisperResult.text?.trim() || null;
    } catch (err) {
      whisperError = err as Error;
      console.warn("[Whisper] 失败，将退化到 Unscripted Azure:", whisperError.message);
    }

    // Step 2: 构造 Azure 发音评估参数
    // Whisper 成功 → Scripted 模式（用 Whisper 文本作为参考）
    // Whisper 失败 → 退化到 Unscripted（老行为，Azure 自己识别）
    // 重要：Unscripted 时 ReferenceText 字段必须完全省略（不能设空字符串）
    const useScripted = whisperText !== null;
    const assessmentConfig: Record<string, unknown> = {
      GradingSystem: "HundredMark", // 百分制
      Granularity: "Phoneme", // Phoneme / Word / FullText
      Dimension: "Comprehensive", // Comprehensive 才会返回完整分数
      EnableMiscue: useScripted, // Scripted 才能开：让 Azure 标记 Omission/Insertion/Substitution
      EnableProsodyAssessment: true, // 韵律评分（en-US 才支持）
    };
    if (useScripted) {
      assessmentConfig.ReferenceText = whisperText;
    }
    const assessmentBase64 = Buffer.from(
      JSON.stringify(assessmentConfig),
    ).toString("base64");

    console.log(
      `[Mode] ${useScripted ? "Scripted" : "Unscripted (Whisper fallback)"}`,
      useScripted ? `ref="${whisperText}"` : "",
    );

    // Step 3: 调 Azure
    const azureResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        Accept: "application/json",
        // 关键：这个 header 触发发音评估
        "Pronunciation-Assessment": assessmentBase64,
      },
      body: audioBuffer,
    });

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text();
      console.error("Azure STT error:", errorText);
      return Response.json(
        { error: `Azure 返回 ${azureResponse.status}: ${errorText}` },
        { status: 500 },
      );
    }

    const result = await azureResponse.json();

    // 调试用：打印 Azure 原始返回
    console.log("[Azure raw]", JSON.stringify(result, null, 2));

    if (result.RecognitionStatus !== "Success") {
      return Response.json({
        text: "",
        pronunciation: null,
        status: result.RecognitionStatus,
        hint: "没识别到内容，可能是太短、没说话或者噪音太大",
      });
    }

    // 从 NBest[0] 提取发音评估数据并简化（原始数据字段名很啰嗦）
    const nBest = result.NBest?.[0];
    const pronunciation = nBest ? simplifyPronunciation(nBest) : null;

    // 对外的主转录文本：Scripted 下就是 Whisper 文本；Unscripted 下退化到 Azure
    const primaryText = whisperText || result.DisplayText || "";

    // 发音数据持久化（fire-and-forget，不阻塞响应）
    if (pronunciation) {
      savePronunciationRecord(
        primaryText,
        pronunciation.scores,
        pronunciation.words,
      ).catch((err) => console.error("[db] 保存发音记录失败:", err));
    }

    return Response.json({
      text: primaryText,
      pronunciation,
      mode: useScripted ? "scripted" : "unscripted",
      whisperFailed: whisperText === null,
    });
  } catch (error) {
    console.error("Transcribe API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

// ========================================
// 把 Azure 的啰嗦 JSON 简化成前端好用的结构
// ========================================
type SimplifiedPronunciation = {
  scores: {
    accuracy: number;
    fluency: number;
    completeness: number;
    prosody: number | null; // 可能没有（非 en-US）
    overall: number;
  };
  words: {
    word: string;
    score: number;
    errorType: string;
    offset: number; // 单位：秒（从音频开头算）
    duration: number; // 单位：秒
    phonemes: { phoneme: string; score: number }[];
    prosody: {
      unexpectedBreak: boolean; // 在这个词前面有不该有的停顿
      missingBreak: boolean; // 在这个词前面该停但没停
      breakLength: number; // 停顿长度（秒）
      monotone: number; // 单调度置信度 0-1（越大越平）
    };
  }[];
};

// Azure REST API 返回的分数字段是平铺在 NBest[0] / word 对象上的
// （不像 SDK 返回的那样嵌套在 PronunciationAssessment 字段下）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function simplifyPronunciation(nBest: any): SimplifiedPronunciation {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Azure 的 Offset/Duration 单位是 100 纳秒（10^-7 秒），转成秒方便前端用
  const words = (nBest.Words || []).map((w: any) => ({
    word: w.Word,
    score: w.AccuracyScore ?? 0,
    errorType: w.ErrorType ?? "None",
    offset: (w.Offset ?? 0) / 10_000_000,
    duration: (w.Duration ?? 0) / 10_000_000,
    prosody: extractWordProsody(w),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phonemes: (w.Phonemes || []).map((p: any) => ({
      phoneme: p.Phoneme,
      score: p.AccuracyScore ?? 0,
    })),
  }));

  return {
    scores: {
      accuracy: nBest.AccuracyScore ?? 0,
      fluency: nBest.FluencyScore ?? 0,
      completeness: nBest.CompletenessScore ?? 0,
      prosody: nBest.ProsodyScore ?? null,
      overall: nBest.PronScore ?? 0,
    },
    words,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractWordProsody(w: any) {
  const fb = w.Feedback?.Prosody || {};
  const brk = fb.Break || {};
  const inton = fb.Intonation || {};
  const errorTypes: string[] = brk.ErrorTypes || [];
  return {
    unexpectedBreak:
      errorTypes.includes("UnexpectedBreak") ||
      (brk.UnexpectedBreak?.Confidence ?? 0) > 1.0,
    missingBreak:
      errorTypes.includes("MissingBreak") ||
      (brk.MissingBreak?.Confidence ?? 0) > 0.8,
    breakLength: (brk.BreakLength ?? 0) / 10_000_000, // 100ns → 秒
    monotone: inton.Monotone?.Confidence ?? 0,
  };
}
