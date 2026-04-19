// ========================================
// Groq Whisper 转录封装
// 为什么要加这个：Azure 对中国口音英语的识别率明显不如 Whisper，
// 经常把 think 听成 sink、导致 AI 回复错 + 发音评估给"错词"打分。
// 现在走双跑策略：转录用 Whisper（更准），发音评估仍用 Azure（独家能力）。
// ========================================

// Groq Whisper API 返回的 verbose_json 结构（我们只用到 text，其他字段留着以后扩展）
export type WhisperResult = {
  text: string; // 完整转录
  language: string; // 自动识别出的语言（应该是 "english"）
  duration: number; // 音频时长（秒）
  // segments 等字段暂不用，省略类型定义
};

// 把音频 Buffer 发给 Groq Whisper，返回转录结果
// audioBuffer: 音频二进制数据（WAV / WebM / MP4 都可以）
// filename: 伪文件名，Groq 用扩展名判断格式（所以扩展名必须对）
export async function transcribeWithWhisper(
  audioBuffer: ArrayBuffer,
  filename: string = "recording.wav",
): Promise<WhisperResult> {
  const apiKey = process.env.GROQ_WHISPER_KEY;
  if (!apiKey) {
    throw new Error("GROQ_WHISPER_KEY 环境变量未配置");
  }

  // 构造 multipart/form-data（模仿 curl -F 的行为）
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioBuffer]),
    filename,
  );
  formData.append("model", "whisper-large-v3");
  formData.append("response_format", "verbose_json");
  formData.append("language", "en"); // 口语陪练就是英语
  formData.append("temperature", "0"); // 避免幻觉（另一个项目踩过 prompt + 非 0 温度的坑）
  // 不加 prompt：
  //   - 参照项目里加 prompt 踩过幻觉循环的坑
  //   - 试过加英文填充词 prompt 引导 verbatim，实测无效（Whisper 清洁行为在训练中已固化）

  const response = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // 不设 Content-Type，fetch 会自动带上 boundary
      },
      body: formData,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Groq Whisper 返回 ${response.status}: ${errorText}`,
    );
  }

  const result = (await response.json()) as WhisperResult;
  return result;
}

