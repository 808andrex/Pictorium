import { describe, expect, it } from "vitest"
import { mergeImageLists } from "@/lib/context"
import type { TMDBImage } from "@/lib/types"

function img(path: string): TMDBImage {
  return { file_path: path, iso_639_1: null, vote_average: 0, width: 0, height: 0 }
}

describe("mergeImageLists", () => {
  it("unions lists without duplicating file paths", () => {
    const out = mergeImageLists(
      { posters: [img("/a.jpg")], logos: [], backdrops: [img("/b1.jpg")] },
      { posters: [img("/a.jpg"), img("/b.jpg")], logos: [img("/l.png")], backdrops: [] },
    )
    expect(out.posters.map((p) => p.file_path)).toEqual(["/a.jpg", "/b.jpg"])
    expect(out.logos.map((p) => p.file_path)).toEqual(["/l.png"])
    expect(out.backdrops.map((p) => p.file_path)).toEqual(["/b1.jpg"])
  })

  it("tolerates missing lists", () => {
    const out = mergeImageLists(
      { posters: [], logos: [], backdrops: [] },
      { posters: [img("/a.jpg")], logos: [], backdrops: [] },
    )
    expect(out.posters.map((p) => p.file_path)).toEqual(["/a.jpg"])
  })
})
