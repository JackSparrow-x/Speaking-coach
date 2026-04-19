// ========================================
// 统一的 LLM 调用
// 用不同于 Claude Code 的环境变量名（避免冲突）
// CLAUDE_PROXY_URL / CLAUDE_PROXY_TOKEN / CLAUDE_PROXY_MODEL
// ========================================

import { recordTokenUsage } from "@/lib/db";

const BASE_URL = process.env.CLAUDE_PROXY_URL || "";
const API_KEY = process.env.CLAUDE_PROXY_TOKEN || "";
export const MODEL = process.env.CLAUDE_PROXY_MODEL || "claude-sonnet-4-5";

type Message = { role: "user" | "assistant"; content: string };

export async function chat(
  system: string,
  messages: Message[],
  maxTokens = 512,
  endpoint?: string, // 可选，用于 token 统计（如 "chat" / "polish"）
): Promise<string> {
  console.log(
    "[llm] calling",
    BASE_URL,
    "model:",
    MODEL,
    "key:",
    API_KEY.slice(0, 6) + "...",
  );

  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[llm] error:", response.status, errorText);
    throw new Error(`${response.status} ${errorText}`);
  }

  const data = await response.json();

  // 记录 token 用量（fire-and-forget，不阻塞主流程）
  // Anthropic API 响应里有 usage.input_tokens / output_tokens
  if (endpoint && data.usage) {
    const inputTokens = Number(data.usage.input_tokens) || 0;
    const outputTokens = Number(data.usage.output_tokens) || 0;
    console.log(
      `[tokens] ${endpoint} ${MODEL}: in=${inputTokens} out=${outputTokens}`,
    );
    recordTokenUsage({
      endpoint,
      model: MODEL,
      inputTokens,
      outputTokens,
    }).catch((err) => console.error("[tokens] 保存失败:", err));
  }

  return data.content?.[0]?.text || "";
}

export async function ask(
  system: string,
  userPrompt: string,
  endpoint?: string, // 同上，为 token 统计传递
): Promise<string> {
  return chat(
    system,
    [{ role: "user", content: userPrompt }],
    1024,
    endpoint,
  );
}
