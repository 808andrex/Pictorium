import { afterEach, describe, expect, it, vi } from "vitest"
import { __clearTMDBCache, __resetKey401Cache, getDetails, getExternalIds } from "@/lib/tmdb"

describe("tmdbFetch per-call timeout (D5)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    __clearTMDBCache()
    __resetKey401Cache()
  })

  it("aborts a hanging fetch after the custom timeout instead of 30s", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        ;(init?.signal as AbortSignal | undefined)?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )
      })
    })

    const start = Date.now()
    await expect(getDetails("movie", 424242, "it-IT", "k", undefined, 80)).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it("still succeeds within the timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: 424243, genres: [], vote_average: 1, vote_count: 1 }),
    )
    const d = await getDetails("movie", 424243, "it-IT", "k", undefined, 5000)
    expect(d.id).toBe(424243)
  })
})

describe("tmdbFetch 401 negative cache (v1.23.0)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    __clearTMDBCache()
    __resetKey401Cache()
  })

  it("marks a 401 key and fails fast without network on retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad key", { status: 401 }))
    await expect(getDetails("movie", 424244, "it-IT", "bad-key", undefined, 5000)).rejects.toThrow("401")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // Seconda chiamata (anche altro endpoint): zero rete, stesso errore.
    await expect(getDetails("movie", 424245, "it-IT", "bad-key", undefined, 5000)).rejects.toThrow("401")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("does not poison other keys or non-401 errors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes("good-key")) return Response.json({ id: 1, genres: [], vote_average: 1, vote_count: 1 })
      return new Response("bad key", { status: 401 })
    })
    await expect(getDetails("movie", 424246, "it-IT", "bad-key", undefined, 5000)).rejects.toThrow("401")
    const d = await getDetails("movie", 424246, "it-IT", "good-key", undefined, 5000)
    expect(d.id).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

/**
 * Joiner inflight: un waiter coalesced su una URL neutra già in volo DEVE
 * rispettare il proprio timeoutMs (e il proprio signal) invece di restare
 * ostaggio del deadline dell'owner. Il fix non tocca l'owner: un solo
 * upstream, entry condivisa mai rimossa dal joiner, stesso valore al
 * rilascio. Regressione via API pubblica reale (getExternalIds, URL neutra
 * esatta `/tv/<id>/external_ids` senza language), fetch globale mockata.
 */
describe("tmdbFetch inflight joiner honors its own timeoutMs (coalesce cap)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    __clearTMDBCache()
    __resetKey401Cache()
  })

  /** Trasporto controllato: resta appeso finché il test lo rilascia. */
  function mockHangingTransport() {
    let release!: (res: Response) => void
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        release = resolve
        ;(init?.signal as AbortSignal | undefined)?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )
      })
    })
    return { fetchSpy, release: (res: Response) => release(res) }
  }

  type RaceOutcome =
    | { kind: "resolved"; value: unknown }
    | { kind: "rejected"; err: unknown }
    | { kind: "stuck" }

  async function raceJoiner(promise: Promise<unknown>, guardMs: number): Promise<RaceOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<RaceOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "stuck" }), guardMs)
    })
    try {
      return await Promise.race([
        promise.then(
          (value): RaceOutcome => ({ kind: "resolved", value }),
          (err): RaceOutcome => ({ kind: "rejected", err }),
        ),
        guard,
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  it("joiner senza signal: scatta sul proprio cap (80ms) mentre l'owner 30s resta attivo", async () => {
    const tvId = 309841
    const payload = { id: tvId, imdb_id: "tt0086817" }
    const { fetchSpy, release } = mockHangingTransport()
    try {
      let ownerOutcome: string | null = null
      // Owner reale: nessun signal esterno, default 30s (come le route senza signal).
      const owner = getExternalIds("tv", tvId, "k").then(
        (value) => {
          ownerOutcome = "resolved"
          return value
        },
        (err) => {
          ownerOutcome = "rejected"
          throw err
        },
      )
      // Joiner sulla STESSA url neutra con cap proprio breve.
      const joiner = getExternalIds("tv", tvId, "k", undefined, 80)
      const start = Date.now()
      const outcome = await raceJoiner(joiner, 2000)
      const elapsed = Date.now() - start
      try {
        // RED sul difetto: outcome.kind === "stuck" (il joiner eredita il 30s dell'owner).
        expect(outcome.kind).toBe("rejected")
        // Cap proprio onorato: molto sotto i 30s dell'owner.
        expect(elapsed).toBeLessThan(2000)
        if (outcome.kind === "rejected") {
          expect((outcome.err as { name?: string } | null)?.name).toMatch(/AbortError|TimeoutError/)
        }
        // Owner intatto: ancora in volo, un solo upstream, signal/transport non abortiti.
        expect(ownerOutcome).toBeNull()
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      } finally {
        // Il trasporto si rilascia sempre: nessuna promise dangling da 30s.
        release(Response.json(payload))
        await expect(owner).resolves.toEqual(payload)
        // Un altro joiner dopo il rilascio riceve lo stesso valore senza nuova rete.
        await expect(getExternalIds("tv", tvId, "k", undefined, 80)).resolves.toEqual(payload)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("joiner con signal esterno live: vince comunque il cap proprio più breve", async () => {
    const tvId = 309842
    const payload = { id: tvId, imdb_id: "tt0903747" }
    const { fetchSpy, release } = mockHangingTransport()
    const callerCtrl = new AbortController()
    try {
      let ownerOutcome: string | null = null
      const owner = getExternalIds("tv", tvId, "k").then(
        (value) => {
          ownerOutcome = "resolved"
          return value
        },
        (err) => {
          ownerOutcome = "rejected"
          throw err
        },
      )
      const joiner = getExternalIds("tv", tvId, "k", callerCtrl.signal, 80)
      const start = Date.now()
      const outcome = await raceJoiner(joiner, 2000)
      const elapsed = Date.now() - start
      try {
        expect(outcome.kind).toBe("rejected")
        expect(elapsed).toBeLessThan(2000)
        if (outcome.kind === "rejected") {
          expect((outcome.err as { name?: string } | null)?.name).toMatch(/AbortError|TimeoutError/)
        }
        // Il signal del chiamante resta live: è il cap a scattare, non un abort esterno.
        expect(callerCtrl.signal.aborted).toBe(false)
        expect(ownerOutcome).toBeNull()
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      } finally {
        release(Response.json(payload))
        await expect(owner).resolves.toEqual(payload)
        await expect(getExternalIds("tv", tvId, "k", callerCtrl.signal, 80)).resolves.toEqual(payload)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("joiner con signal già abortito: rifiuta subito senza toccare l'owner", async () => {
    const tvId = 309843
    const payload = { id: tvId, imdb_id: "tt0417299" }
    const { fetchSpy, release } = mockHangingTransport()
    const callerCtrl = new AbortController()
    callerCtrl.abort()
    try {
      let ownerOutcome: string | null = null
      const owner = getExternalIds("tv", tvId, "k").then(
        (value) => {
          ownerOutcome = "resolved"
          return value
        },
        (err) => {
          ownerOutcome = "rejected"
          throw err
        },
      )
      try {
        const start = Date.now()
        await expect(getExternalIds("tv", tvId, "k", callerCtrl.signal, 30000)).rejects.toThrow()
        expect(Date.now() - start).toBeLessThan(2000)
        // Owner intatto e transport unico.
        expect(ownerOutcome).toBeNull()
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      } finally {
        // Il trasporto si rilascia sempre: nessuna promise dangling da 30s
        // anche se un'asserzione sopra fallisce.
        release(Response.json(payload))
        await expect(owner).resolves.toEqual(payload)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("joiner abortito dopo il join: reason chiamante subito, entry inflight resta per i joiner live", async () => {
    const tvId = 309844
    const payload = { id: tvId, imdb_id: "tt0111161" }
    const { fetchSpy, release } = mockHangingTransport()
    const callerCtrl = new AbortController()
    const callerReason = new Error("caller gone")
    let liveJoiner: Promise<unknown> | null = null
    try {
      let ownerOutcome: string | null = null
      // Owner reale: nessun signal esterno, default 30s (come le route senza signal).
      const owner = getExternalIds("tv", tvId, "k").then(
        (value) => {
          ownerOutcome = "resolved"
          return value
        },
        (err) => {
          ownerOutcome = "rejected"
          throw err
        },
      )
      // Gate esplicito: il transport dell'owner è impegnato prima del join.
      const gateStart = Date.now()
      while (fetchSpy.mock.calls.length === 0) {
        if (Date.now() - gateStart > 2000) throw new Error("transport never engaged")
        await new Promise((r) => setTimeout(r, 5))
      }
      // Joiner con signal live + cap proprio lungo: nessun timer reale a scattare.
      const joiner = getExternalIds("tv", tvId, "k", callerCtrl.signal, 30000)
      // Gate esplicito: il join è coalesced (stessa entry, nessun nuovo upstream)
      // prima dell'abort del chiamante.
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      // Abort esplicito DOPO il join, PRIMA del cap proprio lungo.
      callerCtrl.abort(callerReason)
      const start = Date.now()
      const outcome = await raceJoiner(joiner, 2000)
      try {
        // Il joiner rifiuta subito con la reason del chiamante, non col timeout.
        expect(outcome.kind).toBe("rejected")
        expect(Date.now() - start).toBeLessThan(2000)
        if (outcome.kind === "rejected") {
          expect(outcome.err).toBe(callerReason)
        }
        // Owner intatto: ancora in volo, un solo upstream.
        expect(ownerOutcome).toBeNull()
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        // Un joiner LIVE successivo, mentre l'owner è ancora pending, riusa
        // la STESSA entry inflight (non una nuova fetch, non la cache vuota).
        liveJoiner = getExternalIds("tv", tvId, "k", undefined, 30000)
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 0))
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(ownerOutcome).toBeNull()
      } finally {
        // Rilascio sempre: owner + joiner live si risolvono con lo stesso
        // payload, nessuna promise dangling anche se un'asserzione fallisce.
        release(Response.json(payload))
        await expect(owner).resolves.toEqual(payload)
        expect(liveJoiner).not.toBeNull()
        await expect(liveJoiner as Promise<unknown>).resolves.toEqual(payload)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })
})
