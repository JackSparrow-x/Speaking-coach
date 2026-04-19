// 对话会话管理 API
// POST：创建新会话，返回 sessionId（本地返回 null）

import { createSession } from "@/lib/db";

export async function POST(request: Request) {
  try {
    const { scenarioId } = await request.json();
    const sessionId = await createSession(scenarioId || "free");
    return Response.json({ sessionId }); // 本地会是 null，前端收到 null 就不传
  } catch (error) {
    console.error("Session API error:", error);
    return Response.json({ sessionId: null });
  }
}
