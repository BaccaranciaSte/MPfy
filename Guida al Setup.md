# Guida al Setup

Questa guida spiega come preparare una **fonte**, cioè il server di casa dove si carica la musica. Le strade sono tre, si sceglie quella che si preferisce.

1. Un PC che resta acceso. È la strada più semplice.
2. Un vecchio telefono Android, senza root, con Termux. È la strada giusta per la maggior parte delle persone.
3. Un vecchio telefono Android con root. Per chi se la sente.

In tutti e tre i casi non serve aprire porte sul router e non serve un dominio. La fonte si collega direttamente ai telefoni di casa e di fuori, con un collegamento cifrato.

## Cosa serve

- **Node.js 22** o più recente.
- **ffmpeg**, per preparare le copie leggere dei brani da ascoltare con i dati mobili. Senza, la fonte funziona lo stesso ma manda sempre il file originale.
- **fpcalc** (il pacchetto si chiama chromaprint), per riconoscere i brani doppi e cercare i dettagli in rete. Senza, i doppi si riconoscono solo se il file è identico.
- **7-Zip**, solo se si vogliono caricare archivi 7z o RAR. Gli ZIP funzionano sempre.
- Il codice di MPfy, scaricato da questa pagina (pulsante "Code", poi "Download ZIP") oppure con `git clone`.

## 1. Su un PC

Dopo aver installato Node.js, ffmpeg e fpcalc, si apre un terminale nella cartella di MPfy e si lancia:

```
npm install --omit=dev
```

Poi si accende la fonte, scegliendo una cartella per i dati e un nome:

```
MPFY_DATA=./dati MPFY_NAME="Fonte di casa" node server/index.mjs
```

Su Windows, nel Prompt dei comandi, si scrive invece:

```
set MPFY_DATA=dati
set MPFY_NAME=Fonte di casa
node server/index.mjs
```

Il nome serve solo al primo avvio, poi lo si cambia dall'app. La fonte resta accesa finché il terminale è aperto. Per farla partire da sola all'accensione del PC, su Windows si crea un'attività pianificata che lancia questi comandi all'accesso, su Linux un servizio di systemd.

## 2. Su un vecchio telefono senza root (Termux)

Si installa **Termux** da F-Droid o dalla pagina GitHub di Termux. Quella del Play Store è vecchia e non funziona bene.

In Termux si installano i programmi e si scarica MPfy:

```
pkg update
pkg install nodejs ffmpeg chromaprint git
git clone https://github.com/BaccaranciaSte/MPfy.git mpfy
cd mpfy
npm install --omit=dev
```

Se si vuole usare la microSD, si lancia anche `termux-setup-storage` e si dà il permesso.

Poi si accende la fonte. Questo giro la fa ripartire da sola se si ferma:

```
export MPFY_DATA=$HOME/mpfy-dati MPFY_NAME="Fonte di casa" UV_THREADPOOL_SIZE=8
cd $HOME/mpfy
while true; do node --max-old-space-size=160 server/index.mjs; sleep 10; done
```

Perché resti accesa a schermo spento conviene:

- togliere a Termux l'ottimizzazione della batteria, dalle impostazioni di Android;
- lanciare `termux-wake-lock`;
- per farla partire da sola quando il telefono si riaccende, installare anche **Termux:Boot** e mettere i comandi qui sopra in un file dentro `~/.termux/boot/`.

Il telefono va lasciato in carica e collegato al Wi-Fi di casa.

## 3. Su un vecchio telefono con root

Con il root la fonte gira dentro un ambiente Ubuntu già preparato sul telefono, si installa dal PC con un solo comando e riparte da sola all'avvio. Se sul telefono non c'è già un ambiente Ubuntu, conviene la strada di Termux. È come gira la fonte su cui è stato provato MPfy. Tutti i passi, tecnici, sono in [deploy/README.md](deploy/README.md).

## Collegare l'app alla fonte

La prima persona che collega la fonte ne diventa proprietaria. Per avere il codice, a fonte accesa, si lancia nella cartella di MPfy (con gli stessi `MPFY_DATA` usati per accenderla):

```
node server/index.mjs code
```

Il codice si scrive nell'app, al primo avvio oppure in Impostazioni, aggiungendo una fonte. Per i primi 30 minuti chi la aggiunge diventa il proprietario.

Dopo, il codice lo si ritrova sempre nell'app, in Impostazioni, nella fonte, alla voce "Mostra codice". È lo stesso codice che si dà agli altri della famiglia per farli entrare.

## La microSD

La fonte può tenere i brani anche su una microSD, così com'è, senza formattarla. La scheda si sceglie dall'app, in Impostazioni, nella fonte, alla voce "Scheda di memoria". I brani passano sulla scheda piano piano, ognuno ricontrollato prima di togliere la copia interna. Se la scheda si toglie, i brani restano nella libreria e tornano ascoltabili quando la si rimette.

Con Termux la musica va nella cartella che Android riserva a Termux sulla scheda. Attenzione, disinstallando Termux quella cartella viene cancellata insieme alla musica.

## Cosa conservare

Nella cartella dei dati c'è tutto, i brani, le persone, le playlist e le chat. Il file più importante è `keys.json`, l'identità della fonte. Se si perde, tutti i dispositivi vanno ricollegati da capo. Conviene tenerne una copia in un posto sicuro.

Per una copia completa si copia l'intera cartella dei dati a fonte spenta, mantenendo le date dei file.

## Aggiornare

Si spegne la fonte, si scarica il codice nuovo (con `git pull` se si è usato git), si lancia di nuovo `npm install --omit=dev` e si riaccende. I dati non vengono toccati dagli aggiornamenti.
