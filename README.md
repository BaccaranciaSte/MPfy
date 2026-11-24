# MPfy

Un MP3 virtuale pensato per le famiglie. Dà nuova vita ai dispositivi vecchi e abbandonati, trasformandoli in comodi server di casa dove conservare la vostra musica.

Funziona così, la musica va caricata sulla **fonte** (ovvero il server), cioè un vecchio telefono o un PC che resta acceso in casa. Ognuno ascolta dal proprio telefono o dal PC, in casa o fuori, con un collegamento diretto e cifrato da un capo all'altro. Non ci sono server di altri in mezzo, abbonamenti o account da creare, la musica resta vostra e resta a casa vostra. yey.

## Cosa fa

L'app mostra in un'unica libreria la musica di tutte le fonti a cui si è collegati e quella salvata sul telefono. Se lo stesso brano sta in più posti, lo si vede una volta sola, e fa girare sempre la scelta più conveniente per dare la massima qualità senza sprecare dati mobili, prima il telefono, poi la fonte che risponde meglio.

Copertine, dettagli e testi arrivano dai file stessi. Quando mancano, la fonte (o il telefono, per la sua musica) li cerca in rete da sola, se si dà il permesso all'app.

Ci sono le playlist, i "Mi piace", gli ascoltati di recente, Android Auto e i brani scaricati per ascoltarli senza rete. Chi ascolta dalla stessa fonte può scriversi in chat, mandarsi un brano o una playlist e lasciare un commento sotto una canzone. Chi non vuole farsi vedere può restare invisibile.

L'app si può usare anche senza nessuna fonte, solo con la musica presente sul telefono, stile mp3. Quando poi si collega una fonte, i "Mi piace" e le playlist verranno passati in autonomia.
## Provarla

L'app per Android si scarica dalle [Release](../../releases). Si aggiorna autonomamente quando esce una versione nuova, apparirà un pulsantino in alto a destra.

Al primo avvio chiede il permesso di leggere la musica del telefono. Per collegare una fonte serve il suo codice, che il proprietario può trovare nell'app in Impostazioni.

## Una fonte a casa

La fonte gira con Node.js 22, ffmpeg e fpcalc. Va bene un PC, oppure un vecchio telefono Android, con i permessi di root dentro un ambiente Linux, o senza root dentro Termux. Può leggere la musica anche su una microSD, così com'è, senza formattarla.

Come prepararla, passo per passo, è spiegato nella [Guida al Setup](Guida%20al%20Setup.md).

Una fonte di casa regge comodamente una famiglia. Ho testato su uno Xiaomi Mi A2 Lite del 2018 facendo riprodurre musica da 10 app contemporaneamente alla qualità massima e in 20 alla qualità alta(con venti a qualità massima non c'era una riproduzione pulita, a causa del wifi). Chi ascolta da fuori casa usa la velocità in upload della linea di casa, circa 0,7 Mbit/s a persona alla qualità massima, 0,4 a quella alta.

## Cosa esce da casa

I brani, le playlist, le chat e i commenti risiedono sulla fonte e sui propri dispositivi. Le chat sono cifrate in modo che nemmeno la fonte possa leggerle.

Se è attivo "Cerca i dettagli in rete", per i brani a cui manca qualcosa partono delle richieste ad AcoustID, MusicBrainz, Cover Art Archive e LRCLIB, con l'impronta audio, la durata, titolo, artista e album. Per i brani senza genere nei tag parte solo una ricerca su MusicBrainz con titolo, artista, album e durata, senza impronta audio. Se MusicBrainz non conosce i generi dell'artista, si chiedono a Wikidata con il solo identificativo dell'artista. Mai il file, il nome di chi ascolta o il dispositivo.

La chiave di AcoustID dentro la fonte vale solo per uso non commerciale. Per ogni altro uso serve una chiave propria, che si imposta con `node server/index.mjs acoustid-key <chiave>`.

## Android Auto

Android Auto mostra solo le app del Play Store finché non gli si permettono le altre. Sul telefono si aprono le impostazioni di Android Auto, si tocca dieci volte il numero di versione per sbloccare le impostazioni per sviluppatori, poi da quel menu si attiva "Origini sconosciute". MPfy compare in macchina insieme alle altre app per la musica.

## Per chi vuole metterci le mani

```
npm install
npm test
```

`server/` è la fonte, `client-core/` è il motore che ogni app tiene con sé, `client-node/` lo fa girare su un PC, `web/` è l'interfaccia, `android/` è l'app intorno all'interfaccia, `transport/` è il collegamento diretto.

Per l'app Android, in `android/worklet` si lancia `npm install` e poi `npm run build`. Serve anche `libc++_shared.so` dell'NDK Android r30, da copiare in `android/app/src/main/jniLibs/arm64-v8a/`. Poi, da `android/`, `./gradlew assembleDebug`.

## Licenza

MIT, vedi [LICENSE](LICENSE).
