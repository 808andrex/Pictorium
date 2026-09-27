/**
 * Liste ID premi curate a mano (TMDB IDs) — fonte di verità "forte" per i
 * bollini Vincitore/Candidato, sopra le label generiche Wikidata.
 *
 * Ispirazione: PostersPlus tiene gli stessi set (Globe/Emmy/festival) e li
 * aggiorna a ogni cerimonia. Qui vale lo stesso rituale:
 *
 * PROCEDURA AGGIORNAMENTO ANNUALE (marzo, dopo gli Oscar):
 * 1. Apri le pagine premi TMDB (themoviedb.org/award/...) + Wikipedia per
 *    controllo incrociato.
 * 2. Aggiungi i vincitori dell'anno (e i candidati Best Picture) con commento
 *    `// <film-year> <Titolo>`.
 * 3. Lancia `npx vitest run src/__tests__/award-ids.test.ts` — i test di
 *    guardia bloccano duplicati, overlap win/nom e ID non numerici.
 * 4. `node scripts/write-render-version.mjs` (i poster con nuovi bollini
 *    invalidano la cache da soli via hash).
 *
 * REGOLA D'ORO: gli ID film e gli ID serie di TMDB sono due namespace
 * separati (film/105 = Ritorno al futuro, tv/105 = Sex and the City).
 * MAI cercare un ID nel namespace sbagliato: ogni set dichiara il suo e
 * `lookupAwardIds` sceglie in base a `mediaType`.
 *
 * I nomi canonici ("Oscar", "Golden Globe", ...) corrispondono 1:1 alla
 * priority list di `getAwardBadgeLabel` in badge-labels.ts: le label
 * derivate dagli ID riusano le stesse chiavi di traduzione, niente chiavi
 * nuove, il dropdown e le chiavi cache vedono le stesse stringhe.
 */

export type AwardCanonicalName = "Oscar" | "Golden Globe" | "Emmy" | "Cannes" | "Venezia";

/** Oscar miglior film — VINCITORI (film-year 2015-2024). */
const OSCAR_WINNER_MOVIE_IDS: ReadonlySet<number> = new Set([
  314365, // 2015  Spotlight
  376867, // 2016  Moonlight
  399055, // 2017  The Shape of Water
  490132, // 2018  Green Book
  496243, // 2019  Parasite
  581734, // 2020  Nomadland
  776503, // 2021  CODA
  545611, // 2022  Everything Everywhere All at Once
  872585, // 2023  Oppenheimer
  1064213, // 2024  Anora
]);

/** Oscar miglior film — CANDIDATI non vincitori (film-year 2022-2024). */
const OSCAR_NOMINEE_MOVIE_IDS: ReadonlySet<number> = new Set([
  // 2024
  549509, // The Brutalist
  402431, // Wicked
  974950, // Emilia Pérez
  974576, // Conclave
  693134, // Dune: Part Two
  1028196, // Nickel Boys
  933260, // The Substance
  661539, // A Complete Unknown
  // 2023
  346698, // Barbie
  466420, // Killers of the Flower Moon
  792307, // Poor Things
  840430, // The Holdovers
  1056360, // American Fiction
  915935, // Anatomy of a Fall
  523607, // Maestro
  666277, // Past Lives
  467244, // The Zone of Interest
  // 2022
  674324, // The Banshees of Inisherin
  804095, // The Fabelmans
  817758, // TÁR
  361743, // Top Gun: Maverick
  76600, // Avatar: The Way of Water
  614934, // Elvis
  497828, // Triangle of Sadness
]);

/** Golden Globe film (drama + musical/comedy) — VINCITORI (film-year 2015-2024). */
const GLOBE_WINNER_MOVIE_IDS: ReadonlySet<number> = new Set([
  // Drama
  281957, // 2015  The Revenant
  376867, // 2016  Moonlight
  359940, // 2017  Three Billboards Outside Ebbing, Missouri
  424694, // 2018  Bohemian Rhapsody
  530915, // 2019  1917
  581734, // 2020  Nomadland
  600583, // 2021  The Power of the Dog
  804095, // 2022  The Fabelmans
  872585, // 2023  Oppenheimer
  549509, // 2024  The Brutalist
  // Musical or Comedy
  286217, // 2015  The Martian
  313369, // 2016  La La Land
  391713, // 2017  Lady Bird
  490132, // 2018  Green Book
  466272, // 2019  Once Upon a Time... in Hollywood
  740985, // 2020  Borat Subsequent Moviefilm
  511809, // 2021  West Side Story
  674324, // 2022  The Banshees of Inisherin
  792307, // 2023  Poor Things
  974950, // 2024  Emilia Pérez
]);

/** Golden Globe film — CANDIDATI: seed dal prossimo aggiornamento annuale. */
const GLOBE_NOMINEE_MOVIE_IDS: ReadonlySet<number> = new Set([
]);

/** Golden Globe serie (drama + musical/comedy + limited) — VINCITORI. */
const GLOBE_WINNER_TV_IDS: ReadonlySet<number> = new Set([
  // Drama
  62560, // Mr. Robot
  65494, // The Crown
  69478, // The Handmaid's Tale
  46533, // The Americans
  76331, // Succession
  94997, // House of the Dragon
  126308, // Shōgun
  // Musical or Comedy
  61406, // Transparent
  61744, // Mozart in the Jungle
  65495, // Atlanta
  70796, // The Marvelous Mrs. Maisel
  81290, // The Kominsky Method
  67070, // Fleabag
  61662, // Schitt's Creek
  124101, // Hacks
  136315, // The Bear
  125935, // Abbott Elementary
  // Limited / Anthology
  61697, // Wolf Hall
  66292, // Big Little Lies
  64513, // American Crime Story
  87108, // Chernobyl
  87739, // The Queen's Gambit
  80039, // The Underground Railroad
  111803, // The White Lotus
  154385, // BEEF
  241259, // Baby Reindeer
]);

/** Golden Globe serie — CANDIDATI: seed dal prossimo aggiornamento annuale. */
const GLOBE_NOMINEE_TV_IDS: ReadonlySet<number> = new Set([
]);

/** Emmy (drama + comedy + limited, sole serie) — VINCITORI. */
const EMMY_WINNER_TV_IDS: ReadonlySet<number> = new Set([
  // Drama
  1398, // The Sopranos
  1104, // Mad Men
  1396, // Breaking Bad
  1407, // Homeland
  69478, // The Handmaid's Tale
  1399, // Game of Thrones
  76331, // Succession
  65494, // The Crown
  126308, // Shōgun
  // Comedy
  2316, // The Office
  4608, // 30 Rock
  1421, // Modern Family
  2947, // Veep
  67070, // Fleabag
  61662, // Schitt's Creek
  97546, // Ted Lasso
  124101, // Hacks
  136315, // The Bear
  // Limited
  60622, // Fargo
  66292, // Big Little Lies
  64513, // American Crime Story
  87108, // Chernobyl
  87739, // The Queen's Gambit
  79788, // Watchmen
  80039, // The Underground Railroad
  111803, // The White Lotus
  154385, // BEEF
  241259, // Baby Reindeer
]);

/** Emmy — CANDIDATI: seed dal prossimo aggiornamento annuale. */
const EMMY_NOMINEE_TV_IDS: ReadonlySet<number> = new Set([
]);

/** Palma d'Oro (Cannes) — VINCITORI (film-year 2015-2024; nel 2020 niente festival). */
const CANNES_TOP_IDS: ReadonlySet<number> = new Set([
  314402, // 2015  Dheepan
  374473, // 2016  I, Daniel Blake
  401246, // 2017  The Square
  505192, // 2018  Shoplifters
  496243, // 2019  Parasite
  630240, // 2021  Titane
  497828, // 2022  Triangle of Sadness
  915935, // 2023  Anatomy of a Fall
  1064213, // 2024  Anora
]);

/** Leone d'Oro (Venezia) — VINCITORI (film-year 2015-2024). */
const VENICE_TOP_IDS: ReadonlySet<number> = new Set([
  352162, // 2015  From Afar
  408542, // 2016  The Woman Who Left
  399055, // 2017  The Shape of Water
  426426, // 2018  Roma
  475557, // 2019  Joker
  581734, // 2020  Nomadland
  793998, // 2021  Happening
  1004663, // 2022  All the Beauty and the Bloodshed
  792307, // 2023  Poor Things
  1088514, // 2024  The Room Next Door
]);

export interface AwardIdLookup {
  wins: AwardCanonicalName[];
  noms: AwardCanonicalName[];
}

/**
 * Premi di un TMDB ID, nel namespace giusto (film vs serie).
 * Ordine dei nomi = priority di `getAwardBadgeLabel` (Oscar, Cannes,
 * Venezia, Emmy, Golden Globe): il primo nome vince sui generici Wikidata.
 * Sconosciuto → liste vuote (mai un bollino inventato).
 */
export function lookupAwardIds(
  tmdbId: number | null | undefined,
  mediaType: "movie" | "tv",
): AwardIdLookup {
  const wins: AwardCanonicalName[] = []
  const noms: AwardCanonicalName[] = []
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { wins, noms }
  }
  if (mediaType === "tv") {
    if (GLOBE_WINNER_TV_IDS.has(tmdbId)) wins.push("Golden Globe")
    else if (GLOBE_NOMINEE_TV_IDS.has(tmdbId)) noms.push("Golden Globe")
    if (EMMY_WINNER_TV_IDS.has(tmdbId)) wins.push("Emmy")
    else if (EMMY_NOMINEE_TV_IDS.has(tmdbId)) noms.push("Emmy")
  } else {
    if (OSCAR_WINNER_MOVIE_IDS.has(tmdbId)) wins.push("Oscar")
    else if (OSCAR_NOMINEE_MOVIE_IDS.has(tmdbId)) noms.push("Oscar")
    if (CANNES_TOP_IDS.has(tmdbId)) wins.push("Cannes")
    if (VENICE_TOP_IDS.has(tmdbId)) wins.push("Venezia")
    if (GLOBE_WINNER_MOVIE_IDS.has(tmdbId)) wins.push("Golden Globe")
    else if (GLOBE_NOMINEE_MOVIE_IDS.has(tmdbId)) noms.push("Golden Globe")
  }
  // Cannes/Venezia prima di Golden Globe: stesso ordine di getAwardBadgeLabel.
  wins.sort((a, b) => awardPriority(a) - awardPriority(b))
  noms.sort((a, b) => awardPriority(a) - awardPriority(b))
  return { wins, noms }
}

function awardPriority(name: AwardCanonicalName): number {
  switch (name) {
    case "Oscar": return 0
    case "Cannes": return 1
    case "Venezia": return 2
    case "Emmy": return 3
    case "Golden Globe": return 4
  }
}

/**
 * Fonde i nomi derivati dagli ID in cima alle label Wikidata (dedup):
 * i certi vincono sui generici. Da usare sia nel motore poster
 * (computeTopBadge) che nel dropdown editor (stesse stringhe = stesso sync).
 */
export function withIdAwards(
  tmdbId: number | null | undefined,
  mediaType: "movie" | "tv",
  awards: readonly string[],
): string[] {
  const { wins } = lookupAwardIds(tmdbId, mediaType)
  if (wins.length === 0) return [...awards]
  return [...wins.filter((w) => !awards.includes(w)), ...awards]
}

/** Come sopra per le nomination (solo se nessuna vittoria, come il chiamante). */
export function withIdNoms(
  tmdbId: number | null | undefined,
  mediaType: "movie" | "tv",
  nominations: readonly string[],
): string[] {
  const { noms } = lookupAwardIds(tmdbId, mediaType)
  if (noms.length === 0) return [...nominations]
  return [...noms.filter((n) => !nominations.includes(n)), ...nominations]
}
