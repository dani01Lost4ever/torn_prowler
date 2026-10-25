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

### Key
- Per Prowler serve una key **Limited**: le tue battle stats, il profilo dei target e la ricerca giocatori.
- La **custom key** che FFScouter fa creare non basta, perché non ha il permesso `profile` (in una versione) e non è pensata per Prowler. Mettila nel campo **Key FFScouter**: verrà usata solo per FFScouter, mentre per Torn si usa la key Limited.
- Se la key non ha qualche permesso (codice 16), il sito legge solo quello che può e dice cosa manca. Senza `profile` la ricerca resta disattivata.

### Key secondaria
Torn permette 100 chiamate al minuto **per account**, sommando tutte le key di quell'account. Una seconda key dello stesso account quindi non serve, mentre la key Limited di **un altro account** (es. di un amico) aggiunge altre 100 chiamate.
- Il campo **Key secondaria** è opzionale. Alla connessione il sito controlla con 1 chiamata che la key funzioni, che possa leggere profili e personal stats e che non sia del tuo stesso account.
- Le chiamate sugli altri giocatori (stato, ricerca, faction) vanno alla key con più spazio libero, quindi si alternano da sole. Ogni key ha il suo limite al minuto.
- Le chiamate sui tuoi dati (battle stats, personal stats, log attacchi e fair fight) usano sempre e solo la key principale.
- Se Torn risponde "troppe richieste" su una key, si mette in pausa solo quella per 30 secondi. Se la secondaria smette di funzionare, il sito continua con la principale.

### Stima senza FFScouter
Se FFScouter non risponde o la key non è registrata, il sito passa da solo alla scheda **Stima senza FFScouter**:
1. Cerca giocatori con la ricerca di Torn (`v2/user/search`, 25 per chiamata), filtrati per livello (livello min/max e, se lo imposti, il tuo ± N), non in volo, non in jail e, se non hai impostato "Ospedale entro", non in ospedale. Opzionali: anzianità massima (`daysOld`) e solo senza faction.
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

### Attacchi e database
Dopo un attacco partito dal pulsante **Attacca**, quando torni sulla scheda di Prowler il sito legge il tuo log attacchi (`v2/user/attacks`, solo uscenti) e salva la **fair fight reale** di ogni attacco. Lo fa anche quando ti connetti e con **Aggiorna attacchi**.
- La lettura passa da `server.js` (`POST /api/sync`): il server usa la tua key solo per quella richiesta (2 chiamate Torn: battle stats + attacchi, contate nel limite del browser) e **non la salva**.
- Dalla FF reale ricava il BSS vero del target: BSS target = (FF − 1) × 3/8 × tuo BSS. Con FF 3 è solo un minimo (≥). Le tue battle stats non vengono salvate.
- Il database (SQLite integrato in Node, file `data/prowler.db`, o `DB_PATH`) tiene: i tuoi attacchi (visibili solo a te, dopo la sync con la tua key) e, per ogni giocatore attaccato, nome, livello, faction e BSS ricavato. I BSS sono condivisi tra gli utenti di Prowler.
- La pagina **Attacchi fatti** (in alto, `#attacchi`) elenca le persone che hai attaccato: ultimo attacco, FF reale, respect e BSS ricavato. Con "Aggiorna stato" (per riga o per tutti, 1 chiamata a persona) vedi chi è di nuovo attaccabile; "Solo riattaccabili ora" filtra la lista.
- In tabella il BSS da attacco (ultimi 30 giorni) ha l'etichetta **reale** e vince su FFScouter e sulla stima. Sotto la FF compare "reale X" se hai già attaccato quel giocatore.
- Scheda **Dal database**: i giocatori già attaccati con un BSS noto. Il filtro FF gira senza chiamate e poi si controlla lo stato solo di chi è nel range. Anche "Da faction" senza FFScouter salta la chiamata per i membri già noti.

**Rate limit:**
- **Torn:** il limite di Torn è di 100 chiamate al minuto **per account, sommando tutte le key** (docs ufficiali, "Automatic limits"), quindi una seconda key dello stesso giocatore non aiuta. Il sito non supera mai le 100 chiamate al minuto per key (campo "Limite chiamate/min per key"). Il limite si può abbassare, non alzare. Contano anche gli script e gli altri siti che usano lo stesso account: se li usi insieme a Prowler, abbassalo. Il contatore è nel browser di ciascuno, quindi ogni utente ha il suo. Se Torn risponde con errore 5 (troppe richieste), aspetta 30 secondi e riprova.
- **FFScouter:** il sito rispetta i limiti di ogni endpoint (get-targets 25 al minuto, get-stats 120 al minuto).

## Avvio locale
Serve Node 22.5 o superiore (per `node:sqlite`), senza dipendenze.

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
5. **Persistent Storage:** aggiungi un volume montato su `/app/data`, altrimenti il database si azzera a ogni deploy.
6. **Deploy.** Il container ha un healthcheck su `/`. Non servono variabili d'ambiente.

Il server deve poter raggiungere `api.torn.com` e `ffscouter.com` in uscita.

## Test con API simulate
```
node test/mock-upstream.js &
TORN_BASE=http://localhost:4001 FFS_BASE=http://localhost:4001 node server.js
# apri http://localhost:3000/?proxy con la key AAAAAAAAAAAAAAAA
```
