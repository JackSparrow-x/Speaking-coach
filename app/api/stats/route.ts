// ========================================
// Token 用量统计 API
// GET /api/stats — 返回今天 / 累计 / 每日 / 按 endpoint 的 token 用量
// 前端访问后自己渲染
// ========================================

import { getTokenStats } from "@/lib/db";

export async function GET() {
  try {
    const stats = await getTokenStats();
    return Response.json(stats);
  } catch (error) {
    console.error("Stats API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
