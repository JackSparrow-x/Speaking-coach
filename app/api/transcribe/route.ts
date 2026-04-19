// ========================================
// 后端转录 + 发音评估 API
// 一次调用拿到两样东西：
//   1. 识别出的文字（transcript）
//   2. 发音评分（accuracy / fluency / prosody / 单词级 / 音素级）
// 关键：Azure 把发音评估作为 STT 的扩展功能，靠一个特殊 header 启用
// ========================================

import { savePronunciationRecord } from "@/lib/db";

export async function POST(request: Request) {
  try {
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

    // 发音评估参数（以 base64 JSON 传给 Azure）
    // 重要：Unscripted 模式下，ReferenceText 字段必须完全省略（不能设成空字符串）
    // 空字符串会被当成 Scripted 模式里"参考是空"，导致所有单词都判定错
    const assessmentConfig = {
      GradingSystem: "HundredMark", // 百分制
      Granularity: "Phoneme", // Phoneme / Word / FullText
      Dimension: "Comprehensive", // Comprehensive 才会返回完整分数
      EnableMiscue: false, // Unscripted 下必须 false
      EnableProsodyAssessment: true, // 韵律评分（en-US 才支持）
    };
    const assessmentBase64 = Buffer.from(
      JSON.stringify(assessmentConfig),
    ).toString("base64");

    // format=detailed：让 Azure 返回 NBest 详细数组（发音评分在这里面）
    const endpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;

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
    const pronunciation = nBest
      ? simplifyPronunciation(nBest)
      : null;

    // 发音数据持久化（fire-and-forget，不阻塞响应）
    if (pronunciation) {
      savePronunciationRecord(
        result.DisplayText,
        pronunciation.scores,
        pronunciation.words,
      ).catch((err) => console.error("[db] 保存发音记录失败:", err));
    }

    return Response.json({
      text: result.DisplayText,
      pronunciation,
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
