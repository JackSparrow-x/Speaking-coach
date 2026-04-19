// 对话 API：Claude 对话 + 消息持久化

import { chat } from "@/lib/llm";
import { getScenario } from "@/lib/scenarios";
import { saveMessage, checkAndIncrementQuota } from "@/lib/db";

export async function POST(request: Request) {
  try {
    // 防刷：每天最多 500 次
    const allowed = await checkAndIncrementQuota("chat", 500);
    if (!allowed) {
      return Response.json(
        { error: "今日对话次数已达上限，明天再来" },
        { status: 429 },
      );
    }

    const { messages, scenarioId, sessionId } = await request.json();
    const scenario = getScenario(scenarioId || "free");

    // 保存用户消息（fire-and-forget，不阻塞对话）
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === "user" && sessionId) {
      saveMessage(sessionId, "user", lastUserMsg.content).catch((err) =>
        console.error("[db] 保存用户消息失败:", err),
      );
    }

    // 调 Claude
    const reply = await chat(
      scenario.systemPrompt,
      messages.map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    );

    // 保存 AI 回复（fire-and-forget）
    if (sessionId) {
      saveMessage(sessionId, "assistant", reply).catch((err) =>
        console.error("[db] 保存 AI 消息失败:", err),
      );
    }

    return Response.json({ reply });
  } catch (error) {
    console.error("Chat API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
