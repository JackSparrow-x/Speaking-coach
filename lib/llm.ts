// ========================================
// 统一的 LLM 调用
// 用不同于 Claude Code 的环境变量名（避免冲突）
// CLAUDE_PROXY_URL / CLAUDE_PROXY_TOKEN / CLAUDE_PROXY_MODEL
// ========================================

const BASE_URL = process.env.CLAUDE_PROXY_URL || "";
const API_KEY = process.env.CLAUDE_PROXY_TOKEN || "";
export const MODEL = process.env.CLAUDE_PROXY_MODEL || "claude-sonnet-4-5";

type Message = { role: "user" | "assistant"; content: string };

export async function chat(
  system: string,
  messages: Message[],
  maxTokens = 512,
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
  return data.content?.[0]?.text || "";
}

export async function ask(
  system: string,
  userPrompt: string,
): Promise<string> {
  return chat(system, [{ role: "user", content: userPrompt }], 1024);
}
