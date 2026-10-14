# Pictorium - Visual Regression Testing

> **Per modifiche ai parametri di resa visiva elencati in
> `render-params.md`**, il gate visuale finale prima del push/integrazione è
> obbligatorio. Lo scheduling è definito solo in `AGENTS.md` → Verification
> Strategy: durante il lavoro narrow; visual anticipato solo per diagnosi
> richiesta o necessità dimostrata. Mai clean a ogni edit.

## Comandi

| Regola | Dettaglio |
|---|---|
| Diagnosi durante il lavoro | `npm run e2e:visual` solo quando giustificato; l'app usa `next dev`, non una build production riusata |
| Finale | `.next-e2e` deve essere provably fresh al gate finale: cached valido solo se rebuild relativo alle fonti correnti e dimostrato, altrimenti `npm run e2e:visual:clean` UNA sola volta alla fine |
| Comando | `npx playwright test e2e/pictorium-visual.spec.ts` (solo test visivi) |
| Suite completa | `npx playwright test e2e/ --workers=1` (include smoke test, seriale) |
| Dipendenze esterne | Nessuna: i test usano il mock server locale (`e2e/mock-server.mjs`), avviato da `playwright.config.ts`, che serve TMDB/JustWatch/Wikidata/IMDb con dati deterministici. `TMDB_API_KEY` non serve più. Attenzione: serve una porta dedicata e un `distDir` separato (`.next-e2e`), quindi puoi eseguire i test anche con `npm run dev` attivo. |
| Snapshot intenzionali | Se la modifica ALTERA INTENZIONALMENTE l'aspetto, aggiorna con `npx playwright test --update-snapshots` e committa i nuovi `.png` |
| RENDER_VERSION | Rigenerare tramite `node scripts/write-render-version.mjs` quando richiesto; mai editare il generato a mano né copiare `rv` in documentazione. `predev`/`prebuild`/`pretest` rigenerano automaticamente. |

## Test attivi

- `e2e/pictorium-visual.spec.ts`: screenshot UI e poster, test API funzionali,
  layout, font, badge e formati. Leggere lo spec o l'output del runner per
  l'inventario attuale; niente conteggi duplicati.
- `e2e/pictorium-parity.spec.ts`: confronto debug/pixel tra preview esplicita e
  titolo mappato Stremio. Includerlo nel batch finale per modifiche URL,
  mapping o precedenze, insieme ai relativi unit test.
- Il job CI `visual` esegue solo lo spec visuale: non sostituisce il gate parity.
- `playwright.config.ts` avvia `next dev` con mock e dati isolati per invocazione;
  il riuso dell'app richiede `PLAYWRIGHT_REUSE_APP=1` esplicito. Al gate finale
  rispettare comunque il requisito fresh di `AGENTS.md`.

## Regole

- Fallimento della suite visiva = bloccante. Fix o re-baseline intenzionale; mai ignorare.
- E2E completa (`npx playwright test e2e/ --workers=1`) solo per UI ampia/contratti o prima di integrazione, non a ogni badge-edit.
- Senza visual eseguito, riporta `visual gate pending`: implementazione pronta non è verificata.
- Non committare snapshot rigenerati senza averli revisionati.
- Gli snapshot stanno in git: sono il contratto di regressione.

> Il workflow operativo completo (diagnosi del diff, update snapshots, MCP browser) vive nel skill `poster-visual`.
