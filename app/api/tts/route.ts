// ========================================
// 后端 TTS API：接收文本，用 Azure TTS 合成语音，返回 MP3 音频
// 访问路径：POST /api/tts
// 请求体：{ text: "要朗读的文字" }
// 返回：audio/mpeg 二进制流
// ========================================

import { checkAndIncrementQuota } from "@/lib/db";

export async function POST(request: Request) {
  try {
    // 防刷：每天最多 500 次
    const allowed = await checkAndIncrementQuota("tts", 500);
    if (!allowed) {
      return Response.json(
        { error: "今日语音合成次数已达上限，明天再来" },
        { status: 429 },
      );
    }

    const { text } = await request.json();

    if (!text || typeof text !== "string") {
      return Response.json({ error: "缺少 text 字段" }, { status: 400 });
    }

    // 过滤 emoji（AI 回复里的 emoji 会被 TTS 念出来很怪）
    // 文字气泡保留 emoji 不影响，只在合成语音前剥掉
    const cleanText = stripEmoji(text);

    const region = process.env.AZURE_SPEECH_REGION;
    const key = process.env.AZURE_SPEECH_KEY;

    if (!region || !key) {
      return Response.json(
        { error: "Azure Speech 环境变量未配置" },
        { status: 500 },
      );
    }

    // Azure TTS endpoint
    const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    // 构造 SSML（Speech Synthesis Markup Language）
    // 这是 Azure TTS 的输入格式，可以指定语言、声音、语速、音高等
    // 现在最简单：en-US + Jenny 声音
    const ssml = `
<speak version='1.0' xml:lang='en-US'>
  <voice xml:lang='en-US' name='en-US-JennyNeural'>
    ${escapeXml(cleanText)}
  </voice>
</speak>`.trim();

    const azureResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        // 输出格式：24kHz 48kbps MP3，清晰度够、文件小
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "SpeakingCoach",
      },
      body: ssml,
    });

    if (!azureResponse.ok) {
      const errorText = await azureResponse.text();
      console.error("Azure TTS error:", errorText);
      return Response.json(
        { error: `Azure 返回 ${azureResponse.status}: ${errorText}` },
        { status: 500 },
      );
    }

    // 拿到 MP3 二进制流，直接转发给前端
    const audioBuffer = await azureResponse.arrayBuffer();

    return new Response(audioBuffer, {
      headers: {
        "Content-Type": "audio/mpeg",
      },
    });
  } catch (error) {
    console.error("TTS API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

// 去除 emoji、markdown 标记和多余空白，给 TTS 用
function stripEmoji(text: string): string {
  return text
    // Markdown 标记
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold** → bold
    .replace(/\*(.+?)\*/g, "$1") // *italic* → italic
    .replace(/__(.+?)__/g, "$1") // __bold__ → bold
    .replace(/_(.+?)_/g, "$1") // _italic_ → italic
    .replace(/^>\s*/gm, "") // > quote → quote
    .replace(/^#+\s*/gm, "") // # heading → heading
    .replace(/`([^`]+)`/g, "$1") // `code` → code
    // Emoji 和象形字符
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}\u{1F9B0}-\u{1F9B3}]/gu, "")
    .replace(/\uFE0F/g, "")
    .replace(/\u200D/g, "")
    // 压缩空白
    .replace(/\s+/g, " ")
    .trim();
}

// SSML 是 XML 格式，文本里如果有 < > & " ' 会被当成语法，要转义
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
