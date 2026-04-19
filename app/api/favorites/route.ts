// ========================================
// 收藏夹 API
// POST /api/favorites — toggle：已收藏则删除、未收藏则新增，返回最新状态
// GET  /api/favorites — 列出所有收藏（给收藏夹页面用）
// ========================================

import {
  checkAndIncrementQuota,
  toggleFavorite,
  listFavorites,
} from "@/lib/db";

export async function POST(request: Request) {
  try {
    // 防刷（收藏操作会被频繁点，配额给宽点）
    const allowed = await checkAndIncrementQuota("favorite", 2000);
    if (!allowed) {
      return Response.json(
        { error: "收藏操作过于频繁" },
        { status: 429 },
      );
    }

    const { polishRecordId, text, sourceType } = (await request.json()) as {
      polishRecordId: number;
      text: string;
      sourceType: "natural" | "advanced" | "variant" | "original";
    };

    if (
      typeof polishRecordId !== "number" ||
      !text ||
      !["natural", "advanced", "variant", "original"].includes(sourceType)
    ) {
      return Response.json(
        { error: "参数错误：需要 polishRecordId (number), text, sourceType" },
        { status: 400 },
      );
    }

    const result = await toggleFavorite({ polishRecordId, text, sourceType });
    return Response.json(result);
  } catch (error) {
    console.error("Favorites API error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const favorites = await listFavorites();
    return Response.json({ favorites });
  } catch (error) {
    console.error("Favorites GET error:", error);
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
