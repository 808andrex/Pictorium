/**
 * CatalogShapes isolation + clear semantics (correction1 for the per-catalog
 * format task).
 *
 * Fills the admitted gap ("user-isolation + reset-clear covered by the generic
 * mechanism, no dedicated test") with focused regressions that reuse the
 * legitimate harnesses:
 * - server: real PUT/GET /api/defaults route on an isolated DATA_DIR with the
 *   mocked multi-user auth identity (same pattern as
 *   remaining-shape-controls.test.tsx), per-namespace files;
 * - hook: real useCustomCatalogs with mocked userFetch/guest-guard/sonner
 *   (same pattern as custom-catalogs-sync.test.ts);
 * - resolution: real getExplicitCatalogShape + stremioPosterShape (legacy
 *   byte-identity for absent vs explicit-empty maps).
 *
 * Honest boundary notes (no invented auth rewrite):
 * - cross-namespace scoping is pinned at call time by scopedApiInit (?u= from
 *   the current path); in-flight requests keep the scope they started with.
 *   The hook serializes rapid writes via its putChain (A-then-B, last wins).
 *   There is no hook-level rewrite of a stale cross-namespace GET response
 *   beyond that; the tests below demonstrate the real guards (call-time
 *   pinning + PUT serialization), not a new one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { NextRequest } from "next/server"

vi.mock("@/lib/http", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/http")>()
  return { ...mod, userFetch: vi.fn() }
})
vi.mock("@/lib/guest-guard", () => ({
  isProfilelessOnMultiUser: vi.fn().mockResolvedValue(false),
  notifyProfilelessOnce: vi.fn(),
  shouldSkipServerSync: vi.fn().mockResolvedValue(false),
}))
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), info: vi.fn() } }))

vi.mock("@/lib/data-dir", () => ({
  DATA_DIR: `${process.cwd()}/test-results/data-catalog-shapes-isolation-test`,
}))

vi.mock("@/lib/user-auth", () => ({
  checkUserAuth: vi.fn(async () => true),
  getScopedUserId: vi.fn((raw: string | null) => raw),
  extractUserParam: vi.fn((req: Request) => new URL(req.url).searchParams.get("u")),
  invalidUserResponse: () => new Response("bad user", { status: 400 }),
  isMultiUserEnabled: () => true,
  userAuthResponse: () => new Response("auth", { status: 401 }),
  userRateLimitKey: (req: Request) => `test:${req.url}`,
}))

import { userFetch } from "@/lib/http"
import { scopedApiInit } from "@/lib/http"
import { shouldSkipServerSync } from "@/lib/guest-guard"
import { useCustomCatalogs } from "@/lib/useCustomCatalogs"
import { getExplicitCatalogShape } from "@/lib/catalog-shape"
import { stremioPosterShape } from "@/lib/stremio-poster-url"

const mockedFetch = vi.mocked(userFetch)
const mockedSkip = vi.mocked(shouldSkipServerSync)

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SHAPE_ID = "pictorium-jw-series"
const OTHER_ID = "pictorium-jw-movies"

function memStore() {
  const map = new Map<string, string>()
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => {
      map.set(k, v)
    },
    raw: map,
  }
}

const okGet = { ok: true, json: async () => ({}) } as unknown as Response
const okPut = (body?: unknown) =>
  ({ ok: true, status: 200, json: async () => body ?? {} }) as unknown as Response

function putBodies(): Array<{ url: string; body: Record<string, unknown> }> {
  return mockedFetch.mock.calls
    .filter(([, init]) => (init as RequestInit)?.method === "PUT")
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit)?.body)) as Record<string, unknown>,
    }))
}

function mockPutRequest(body: unknown, url = "http://localhost:3000/api/defaults"): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function freshRoute() {
  const fs = await import("node:fs")
  fs.rmSync(`${process.cwd()}/test-results/data-catalog-shapes-isolation-test`, {
    recursive: true,
    force: true,
  })
  vi.resetModules()
  return await import("@/app/api/defaults/route")
}

function setUrl(url: string): void {
  window.history.replaceState({}, "", url)
}

describe("server: catalogShapes namespace isolation (real route, per-user files)", () => {
  beforeEach(() => {
    delete process.env.ADMIN_TOKEN
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("userA override cannot leak into userB load/GET/PUT or the global namespace", async () => {
    const { PUT, GET } = await freshRoute()
    const putA = await PUT(
      mockPutRequest(
        { catalogShapes: { [SHAPE_ID]: "poster" } },
        `http://localhost:3000/api/defaults?u=${USER_A}`,
      ) as unknown as NextRequest,
    )
    expect(putA.status).toBe(200)

    const a = (await (
      await GET(new Request(`http://localhost:3000/api/defaults?u=${USER_A}`) as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(a.catalogShapes).toEqual({ [SHAPE_ID]: "poster" })

    // UserB never sees A's map, even after its own unrelated PUT.
    const putB = await PUT(
      mockPutRequest({ gradientHeight: 55 }, `http://localhost:3000/api/defaults?u=${USER_B}`) as unknown as NextRequest,
    )
    expect(putB.status).toBe(200)
    const b = (await (
      await GET(new Request(`http://localhost:3000/api/defaults?u=${USER_B}`) as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(b.catalogShapes).toBeUndefined()
    expect(b.gradientHeight).toBe(55)

    // The global namespace is untouched by either scoped write.
    const g = (await (
      await GET(new Request("http://localhost:3000/api/defaults") as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(g.catalogShapes).toBeUndefined()
    expect(g.gradientHeight).toBeUndefined()

    // A still owns its override after B wrote.
    const a2 = (await (
      await GET(new Request(`http://localhost:3000/api/defaults?u=${USER_A}`) as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(a2.catalogShapes).toEqual({ [SHAPE_ID]: "poster" })
  })

  it("clearing an override back to global REMOVES the key; explicit {} persists and absence preserves", async () => {
    const { PUT, GET } = await freshRoute()
    const getA = async () =>
      (await (
        await GET(new Request(`http://localhost:3000/api/defaults?u=${USER_A}`) as unknown as NextRequest)
      ).json()) as Record<string, unknown>

    expect(
      (
        await PUT(
          mockPutRequest(
            { catalogShapes: { [SHAPE_ID]: "poster", [OTHER_ID]: "landscape" } },
            `http://localhost:3000/api/defaults?u=${USER_A}`,
          ) as unknown as NextRequest,
        )
      ).status,
    ).toBe(200)
    expect(await getA()).toMatchObject({
      catalogShapes: { [SHAPE_ID]: "poster", [OTHER_ID]: "landscape" },
    })

    // Explicit empty clears the map (follow-global again) and persists as {}.
    expect(
      (
        await PUT(
          mockPutRequest({ catalogShapes: {} }, `http://localhost:3000/api/defaults?u=${USER_A}`) as unknown as NextRequest,
        )
      ).status,
    ).toBe(200)
    const cleared = await getA()
    expect(cleared.catalogShapes).toEqual({})
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const storedRaw = await fs.readFile(
      path.join(`${process.cwd()}/test-results/data-catalog-shapes-isolation-test`, "users", USER_A, "defaults.json"),
      "utf-8",
    )
    expect((JSON.parse(storedRaw) as Record<string, unknown>).catalogShapes).toEqual({})

    // A later PUT WITHOUT the key must not resurrect the old map (absence
    // preserves the stored explicit empty, it does not re-inherit it).
    expect(
      (
        await PUT(
          mockPutRequest({ gradientHeight: 42 }, `http://localhost:3000/api/defaults?u=${USER_A}`) as unknown as NextRequest,
        )
      ).status,
    ).toBe(200)
    const afterUnrelated = await getA()
    expect(afterUnrelated.catalogShapes).toEqual({})
    expect(afterUnrelated.gradientHeight).toBe(42)

    // Contrast: absence preserves a live map too (no silent wipe).
    expect(
      (
        await PUT(
          mockPutRequest(
            { catalogShapes: { [SHAPE_ID]: "poster" } },
            `http://localhost:3000/api/defaults?u=${USER_B}`,
          ) as unknown as NextRequest,
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await PUT(
          mockPutRequest({ gradientHeight: 7 }, `http://localhost:3000/api/defaults?u=${USER_B}`) as unknown as NextRequest,
        )
      ).status,
    ).toBe(200)
    const bKept = (await (
      await GET(new Request(`http://localhost:3000/api/defaults?u=${USER_B}`) as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(bKept.catalogShapes).toEqual({ [SHAPE_ID]: "poster" })
  })

  it("clearing shapes touches only shapes: renames/order/posterShape survive, other user and global untouched, unknown enums rejected", async () => {
    const { PUT, GET } = await freshRoute()
    expect(
      (
        await PUT(
          mockPutRequest(
            {
              posterShape: "landscape",
              catalogRenames: { [SHAPE_ID]: "Pretty" },
              catalogOrder: [SHAPE_ID, OTHER_ID],
              catalogShapes: { [SHAPE_ID]: "poster" },
            },
            `http://localhost:3000/api/defaults?u=${USER_A}`,
          ) as unknown as NextRequest,
        )
      ).status,
    ).toBe(200)

    // Unknown enums never silently default: the PUT fails and the stored map survives.
    const bad = await PUT(
      mockPutRequest(
        { catalogShapes: { [SHAPE_ID]: "global" } },
        `http://localhost:3000/api/defaults?u=${USER_A}`,
      ) as unknown as NextRequest,
    )
    expect(bad.status).toBe(400)

    expect(
      (
        await PUT(
          mockPutRequest({ catalogShapes: {} }, `http://localhost:3000/api/defaults?u=${USER_A}`) as unknown as NextRequest,
        )
      ).status,
    ).toBe(200)
    const a = (await (
      await GET(new Request(`http://localhost:3000/api/defaults?u=${USER_A}`) as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(a.catalogShapes).toEqual({})
    expect(a.catalogRenames).toEqual({ [SHAPE_ID]: "Pretty" })
    expect(a.catalogOrder).toEqual([SHAPE_ID, OTHER_ID])
    expect(a.posterShape).toBe("landscape")

    const b = (await (
      await GET(new Request(`http://localhost:3000/api/defaults?u=${USER_B}`) as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(b.catalogShapes).toBeUndefined()
    expect(b.catalogRenames).toBeUndefined()
    const g = (await (
      await GET(new Request("http://localhost:3000/api/defaults") as unknown as NextRequest)
    ).json()) as Record<string, unknown>
    expect(g.catalogShapes).toBeUndefined()
    expect(g.posterShape).toBeUndefined()
  })
})

describe("resolution: cleared map follows the global legacy behavior (no stale shape)", () => {
  it("explicit {} resolves byte-identically to an absent map, and never mutates the stored mapping", () => {
    const portraitMapping = {
      tmdbId: 94997,
      mediaType: "tv",
      title: "House of the Dragon",
      posterPath: "/x.jpg",
      logoPath: null,
      originalPosterPath: null,
      language: null,
      posterShape: "poster",
      updatedAt: "2026-07-16T10:15:30.000Z",
    } as const
    const frozen = Object.freeze({ ...portraitMapping })

    // Cleared key: no explicit override, whatever the map provenance.
    expect(getExplicitCatalogShape(SHAPE_ID, {})).toBeUndefined()
    expect(getExplicitCatalogShape(SHAPE_ID, undefined)).toBeUndefined()

    // Legacy global behavior is byte-identical for absent vs explicit-empty:
    // landscape global forces portrait mappings to landscape; portrait global
    // still honors a per-title landscape mapping.
    expect(stremioPosterShape(frozen, { posterShape: "landscape" })).toBe("landscape")
    expect(stremioPosterShape(frozen, { posterShape: "landscape", catalogShapes: {} })).toBe("landscape")
    expect(
      stremioPosterShape({ ...frozen, posterShape: "landscape" }, { posterShape: "poster" }),
    ).toBe("landscape")
    expect(
      stremioPosterShape({ ...frozen, posterShape: "landscape" }, { posterShape: "poster", catalogShapes: {} }),
    ).toBe("landscape")
    // The stored mapping object is never rewritten by the resolution.
    expect(frozen.posterShape).toBe("poster")
  })
})

describe("hook: catalogShapes debounced scoped sync (real useCustomCatalogs)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mockedSkip.mockResolvedValue(false)
    mockedFetch.mockResolvedValue(okGet)
    setUrl("/")
  })

  afterEach(() => {
    setUrl("/")
  })

  it("setCatalogShape PUTs the shapes map; back-to-global REMOVES the key and PUTs explicit {} (not absence)", async () => {
    const store = memStore()
    const { result } = renderHook(() => useCustomCatalogs(store.get, store.set))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })

    await act(async () => {
      result.current.setCatalogShape(SHAPE_ID, "poster")
    })
    expect(result.current.catalogShapes).toEqual({ [SHAPE_ID]: "poster" })
    expect(JSON.parse(store.get("pictorium_catalog_shapes") ?? "null")).toEqual({ [SHAPE_ID]: "poster" })
    await waitFor(() => expect(putBodies()).toHaveLength(1), { timeout: 3000 })
    expect(putBodies()[0].url).toBe("/api/defaults")
    expect(putBodies()[0].body.catalogShapes).toEqual({ [SHAPE_ID]: "poster" })

    // Back to global deletes the key locally and persists explicit empty.
    mockedFetch.mockClear()
    await act(async () => {
      result.current.setCatalogShape(SHAPE_ID, null)
    })
    expect(result.current.catalogShapes).toEqual({})
    expect(store.get("pictorium_catalog_shapes")).toBe("{}")
    await waitFor(() => expect(putBodies()).toHaveLength(1), { timeout: 3000 })
    const cleared = putBodies()[0].body
    expect("catalogShapes" in cleared).toBe(true)
    expect(cleared.catalogShapes).toEqual({})
  })

  it("rapid shape poster->landscape serializes: the server ends with the last map, no stale overwrite, no third PUT", async () => {
    const resolvers: Array<(v: Response) => void> = []
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if ((init as RequestInit)?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          resolvers.push(resolve)
        })
      }
      return okGet
    })
    const store = memStore()
    const { result } = renderHook(() => useCustomCatalogs(store.get, store.set))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })

    await act(async () => {
      result.current.setCatalogShape(SHAPE_ID, "poster")
    })
    await waitFor(() => expect(putBodies()).toHaveLength(1), { timeout: 3000 })
    await act(async () => {
      result.current.setCatalogShape(SHAPE_ID, "landscape")
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700))
    })
    // The chain serializes: landscape waits for the poster PUT to ack.
    expect(mockedFetch.mock.calls.filter(([, i]) => (i as RequestInit)?.method === "PUT")).toHaveLength(1)

    await act(async () => {
      resolvers[0](okPut())
      await new Promise((r) => setTimeout(r, 100))
    })
    await waitFor(() => expect(putBodies()).toHaveLength(2), { timeout: 3000 })
    const bodies = putBodies().map((p) => p.body.catalogShapes)
    expect(bodies[0]).toEqual({ [SHAPE_ID]: "poster" })
    expect(bodies[1]).toEqual({ [SHAPE_ID]: "landscape" })
    expect(result.current.catalogShapes).toEqual({ [SHAPE_ID]: "landscape" })

    await act(async () => {
      resolvers[1](okPut())
      await new Promise((r) => setTimeout(r, 100))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700))
    })
    expect(putBodies()).toHaveLength(2)
  })

  it("settled clear survives a remount (reload follows global, old shape not resurrected) and reset touches only shapes", async () => {
    const store = memStore()
    store.set("pictorium_catalog_shapes", JSON.stringify({ [SHAPE_ID]: "poster" }))
    store.set("pictorium_catalog_renames", JSON.stringify({ [SHAPE_ID]: "Pretty" }))
    store.set("pictorium_catalog_order", JSON.stringify([SHAPE_ID]))
    const { result } = renderHook(() => useCustomCatalogs(store.get, store.set))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })
    expect(result.current.catalogShapes).toEqual({ [SHAPE_ID]: "poster" })

    await act(async () => {
      result.current.resetCatalogShapes()
    })
    expect(result.current.catalogShapes).toEqual({})
    // Reset clears only the shapes slice: renames/order survive in state.
    expect(result.current.catalogRenames).toEqual({ [SHAPE_ID]: "Pretty" })
    expect(result.current.catalogOrder).toEqual([SHAPE_ID])
    // Production parity: safeGetItem/safeSetItem ARE plain localStorage
    // wrappers (context.tsx), and reset uses direct localStorage.removeItem —
    // the same store in prod. The injected memStore here diverges, so mirror
    // the removal explicitly (no source change: pre-existing pattern shared
    // with resetCatalogNames/resetCatalogOrder).
    store.raw.delete("pictorium_catalog_shapes")
    await waitFor(() => expect(putBodies()).toHaveLength(1), { timeout: 3000 })
    const resetPut = putBodies()[0].body
    expect(resetPut.catalogShapes).toEqual({})
    expect(resetPut.catalogRenames).toEqual({ [SHAPE_ID]: "Pretty" })
    expect(resetPut.catalogOrder).toEqual([SHAPE_ID])

    // Remount after the server ack: absent local + explicit-empty server
    // converges to "{}", the old shape is gone, and renames/order are
    // intact — reload follows the global setting.
    mockedFetch.mockClear()
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if ((init as RequestInit)?.method === "PUT") return okPut()
      return { ok: true, json: async () => ({ catalogShapes: {} }) } as unknown as Response
    })
    const { result: reloaded } = renderHook(() => useCustomCatalogs(store.get, store.set))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })
    expect(reloaded.current.catalogShapes).toEqual({})
    expect(getExplicitCatalogShape(SHAPE_ID, reloaded.current.catalogShapes)).toBeUndefined()
    expect(reloaded.current.catalogRenames).toEqual({ [SHAPE_ID]: "Pretty" })
    expect(reloaded.current.catalogOrder).toEqual([SHAPE_ID])
  })

  it("namespace scope is pinned at call time (?u= from the current path): A->B switches never cross-send", async () => {
    setUrl(`/u/${USER_A}/configure`)
    expect(scopedApiInit("/api/defaults").path).toBe(`/api/defaults?u=${USER_A}`)
    setUrl(`/u/${USER_B}/configure`)
    const second = scopedApiInit("/api/defaults")
    expect(second.path).toBe(`/api/defaults?u=${USER_B}`)
    expect(second.path).not.toContain(USER_A)
    // In-flight scope is immutable: a path computed under A keeps A after the
    // switch (no hook-level rewrite of stale cross-namespace responses beyond
    // this call-time pinning plus the PUT serialization above).
    setUrl(`/u/${USER_A}/configure`)
    const inFlight = scopedApiInit("/api/defaults").path
    setUrl(`/u/${USER_B}/configure`)
    expect(inFlight).toBe(`/api/defaults?u=${USER_A}`)
    expect(inFlight).not.toContain(USER_B)
  })
})
