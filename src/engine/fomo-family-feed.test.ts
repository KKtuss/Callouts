import { describe, expect, it } from "vitest"
import {
  fomoFamilyTradeCommentsUrl,
  parseFomoFamilyCommentsPayload,
} from "@/engine/fomo-family-feed"

const mint = "6JyC2e2U4ZnYZhQL8MB8nus6XwejUrpC11ttGUY3pump"

describe("fomo-family-feed", () => {
  it("parses trade comments as theses", () => {
    const rows = parseFomoFamilyCommentsPayload(
      {
        success: true,
        message: "Comments found",
        responseObject: {
          comments: [
            {
              id: "8fa3144e-8889-4a2d-a501-2b39d608b478",
              userId: "bbc468f4-e740-5f26-9441-299452f1495c",
              tradeId: "9eda3e02-5b04-4e8c-9f8c-e5a812927fb7",
              comment: "test",
              createdAt: "2026-09-20T19:48:08.772Z",
              parentId: null,
              tokenAddress: mint,
              networkId: 1399811149,
            },
            {
              id: "reply",
              userId: "x",
              tradeId: "9eda3e02-5b04-4e8c-9f8c-e5a812927fb7",
              comment: "reply",
              createdAt: "2026-09-20T19:49:08.772Z",
              parentId: "8fa3144e-8889-4a2d-a501-2b39d608b478",
              tokenAddress: mint,
            },
          ],
          hasNextPage: false,
        },
        statusCode: 200,
      },
      mint,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      commentId: "8fa3144e-8889-4a2d-a501-2b39d608b478",
      userId: "bbc468f4-e740-5f26-9441-299452f1495c",
      thesis: "test",
      tokenAddress: mint,
      handle: null,
    })
    expect(fomoFamilyTradeCommentsUrl("abc")).toContain("/trades/abc/comments")
  })
})
