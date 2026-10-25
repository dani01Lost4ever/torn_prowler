# Prowler: target finder per Torn

Sito che, data la tua API key di Torn, trova target attaccabili:
- **stato "Okay"**: esclude chi è in ospedale, in jail, in volo o all'estero. In opzione include chi esce dall'ospedale entro N minuti, solo per gli ospedali di Torn.
- **nel tuo range di fair fight**, usando le stime BSS di [FFScouter](https://ffscouter.com).

## Come funziona
1. Con la tua key (accesso **Limited**) legge le tue battle stats e calcola il tuo BSS = √str + √def + √spd + √dex.
2. Trova i candidati in uno di tre modi:
   - **Ricerca FFScouter**: `get-targets` filtrato per FF e livello, fino a 50 per pagina.
   - **Da faction**: una chiamata `faction/{id}?selections=basic` per faction dà lo stato di tutti i membri. Poi le stat si stimano in blocco con `get-stats` di FFScouter.
   - **Lista ID**: ID incollati a mano.
   - **Stima senza FFScouter**: per quando FFScouter non è disponibile (vedi sotto).
3. Verifica lo stato reale di ogni candidato su `api.torn.com/user/{id}?selections=profile` e tiene solo quelli attaccabili.
4. Ricontrolla i primi 30 target ogni minuto e toglie chi non è più attaccabile.

### Stima senza FFScouter
Se FFScouter non risponde o la key non è registrata, il sito passa da solo alla scheda **Stima senza FFScouter**:
1. Cerca giocatori con la ricerca di Torn (`v2/user/search`, 25 per chiamata), filtrati per livello (il tuo ± N), non in volo, non in jail e, se non hai impostato "Ospedale entro", non in ospedale. Opzionali: anzianità massima (`daysOld`) e solo senza faction.
2. Per ogni candidato fa **una** chiamata `user/{id}?selections=profile,personalstats`, che dà sia lo stato attuale sia le personal stats e l'anzianità.
3. Calcola un'"energia spesa in palestra" stimata, per il target e per te:
   `(xanax × 250 + energy refill × 150 + energy can × 20 + LSD × 50 + giorni di gioco × 120) × (1 + 1% × stat enhancer)`.
   I pesi sono in `EST_WEIGHTS` in `public/app.js`.
4. BSS stimato del target = tuo BSS × √(sua energia / tua energia). Da qui FF e respect come sopra.

In tabella questi valori hanno il prefisso `~` e l'etichetta *stima*; passando il mouse sul BSS si vede il confronto voce per voce. È una stima grezza: non vede gym, perk, educazione né stat comprate.
Le stesse personal stats si usano anche in "Da faction" e "Lista ID" quando FFScouter manca (in "Da faction" costa una chiamata per membro).

Formule:
- FF = 1 + 8/3 × (BSS target / tuo BSS), tra 1 e 3.
- Respect ≈ round((lv + 197) / 198, 2) × FF.

**Rate limit:**
- **Torn:** il sito non supera mai le 60 chiamate al minuto per utente. Il limite si può abbassare, non alzare. Il contatore è nel browser di ciascuno, quindi ogni utente ha il suo. Se Torn risponde con errore 5 (troppe richieste), aspetta 30 secondi e riprova.
- **FFScouter:** il sito rispetta i limiti di ogni endpoint (get-targets 25 al minuto, get-stats 120 al minuto).

## Avvio locale
Serve Node 18 o superiore, senza dipendenze.

```
node server.js
# apri http://localhost:3000
```

`server.js` serve il sito e fa da proxy (`/proxy/torn/...`, `/proxy/ffs/...`) per quando il browser blocca le chiamate dirette per CORS.
- Il browser prova prima la chiamata diretta e passa al proxy solo se questa fallisce.
- Il server non salva né scrive nei log la key.
- Con `?proxy` nell'URL il sito usa sempre il proxy.

## Deploy
Va bene qualsiasi hosting Node: Render, Railway, Fly.io o una VPS. Il comando di avvio è `npm start` e la porta viene letta da `PORT`.

Attenzione se il sito è pubblico e le chiamate passano dal proxy: verso FFScouter tutti gli utenti escono con l'IP del server, e FFScouter applica i limiti per IP.

### Coolify
1. In Coolify: **+ New → Resource → Private Repository (with GitHub App)** oppure **Public Repository**, e scegli `dani01Lost4ever/torn_prowler`, branch `main`.
2. **Build Pack:** `Dockerfile`, il file è già nella root del repo.
3. **Ports Exposes:** `3000`.
4. **Domains:** inserisci il dominio (es. `https://prowler.tuodominio.it`). Coolify crea il certificato HTTPS.
5. **Deploy.** Il container ha un healthcheck su `/`. Non servono variabili d'ambiente.

Il server deve poter raggiungere `api.torn.com` e `ffscouter.com` in uscita.

## Test con API simulate
```
node test/mock-upstream.js &
TORN_BASE=http://localhost:4001 FFS_BASE=http://localhost:4001 node server.js
# apri http://localhost:3000/?proxy con la key AAAAAAAAAAAAAAAA
```
