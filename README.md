# BO-WERT Konfektionierung

Handy-Web-App für die Konfektionierung: Zu einer **Auftragsnummer** sofort sehen, welcher **Artikel** dazugehört,
welche **Materialien** gebraucht werden und **wo sie im Lager liegen** – und entnommenes Material direkt auf die
**Bestellliste** setzen. Alle Mitarbeiter arbeiten mit denselben Daten.

**App:** https://steffenkastian.github.io/bowert-konfektionierung/ · Passwort: `bowert`

## Struktur

```
Auftragsnummer  ──►  Artikelbezeichnung (z. B. „5er“, „200er“)  ──►  Materialien (Artikelnummern)
                     └─ Packhinweise (Fotos / PDFs)                   ├─ Beschreibung (optional)
                                                                      └─ Lagerort     (optional)
```

Ein Material (Artikelnummer) wird nur einmal gepflegt. Ändert sich sein Lagerort, gilt das für alle Artikel.

## Bedienung

| Bereich | Wofür |
| --- | --- |
| **Suche** (Start) | Auftragsnummer, Artikelbezeichnung, Artikelnummer oder Lagerort eintippen. „202878“ findet auch „630-202878X“. **123** schaltet auf die Zahlentastatur. |
| **Aufträge** | Status je Auftrag: **Nicht begonnen · In Arbeit · Abgeschlossen** (auf der Auftragsseite mit einem Tipp umschalten, Liste danach filtern, „In Arbeit“ steht auch auf der Startseite). Auftrag anlegen und Artikelbezeichnung zuordnen – beim Tippen („5“) werden passende Artikel vorgeschlagen, inkl. Vorschau der Materialien. Unbekannte Bezeichnungen werden neu angelegt. |
| **Artikel** | Materialien per Artikelnummer zuordnen. Bekannte Nummern füllen Beschreibung und Lagerort automatisch aus. **Packhinweise:** Foto (direkt mit der Kamera) oder PDF hochladen – erscheint bei jedem Auftrag mit diesem Artikel. Antippen zeigt Foto bzw. alle PDF-Seiten in der App; umbenennen, teilen, löschen. |
| **Material** | Alle Materialien mit Lagerort, sortierbar. |
| **Bestellliste** | Überall, wo ein Lagerort steht, gibt es **Entnehmen** → das Material landet hier (mehrfach tippen = Menge +1). Menge anpassen, als *bestellt* markieren, bei Eintreffen abhaken, Liste per WhatsApp/Mail **teilen**. |
| ⚙ **Mehr** | Datenbestand, Sicherungskopie (JSON), Anleitung „Als App installieren“, Abmelden. |

## Speicherung & Sicherheit

- Daten liegen in **Firebase Firestore** (Projekt `bowert-konfektionierung`, Region Frankfurt `europe-west3`),
  kostenloser Spark-Tarif. Änderungen erscheinen sofort auf allen Handys.
- **Offline-fähig:** Ohne Empfang läuft die App mit den zuletzt geladenen Daten weiter; Änderungen werden
  übertragen, sobald wieder Verbindung besteht (Anzeige „Offline“ / „Sync“ oben).
- **Login:** gemeinsames Team-Konto `konfektionierung@bowert-gmbh.de`, in der App wird nur das Passwort eingegeben.
  Das Passwort prüft der Firebase-Server; die Regeln in [`firestore.rules`](firestore.rules) lassen nur dieses
  Konto lesen/schreiben. Passwort ändern: Firebase-Konsole → Authentication → Nutzer.
- Die Firebase-Konfiguration in `js/config.js` ist absichtlich öffentlich (so funktionieren alle Firebase-Web-Apps).
- **Packhinweise** liegen ebenfalls in Firestore (Sammlung `files`, in Stücken < 1 MB), nicht in Firebase Storage –
  das bräuchte den kostenpflichtigen Blaze-Tarif. Fotos werden vor dem Hochladen auf max. 2200 px verkleinert
  (meist 200–600 KB), PDFs bis 15 MB. Eine Datei wird erst beim Antippen geladen und ist danach auf dem Handy
  auch offline verfügbar. Die Sicherungskopie (JSON) enthält nur die Liste der Packhinweise, nicht die Dateien.

## Technik

Reines HTML/CSS/JavaScript ohne Build-Schritt, Firebase-SDK direkt vom Google-CDN.

```
index.html             Grundgerüst (Login, Kopfzeile, Tab-Leiste)
css/app.css            Gestaltung (mobil zuerst, Hell/Dunkel)
js/app.js              Routing, Login, alle Ansichten
js/store.js            Firestore: Live-Abgleich, Speichern, Bestellliste
js/config.js           Firebase-Projektdaten + Team-Konto
js/ui.js               Helfer: Suche, Sortierung, Icons, Vorschläge
js/files.js            Packhinweise: Fotos verkleinern, PDF-Anzeige
vendor/pdfjs/          pdf.js 4.10.38 (Mozilla, Apache-2.0) zum Anzeigen von PDFs
sw.js                  Service Worker (App-Dateien offline)
firestore.rules        Zugriffsregeln der Datenbank
```

**Neue Version veröffentlichen:** committen und pushen, vorher in `sw.js` die Konstante `CACHE` hochzählen
(z. B. `konf-v5`), damit installierte Apps die neuen Dateien laden.
**Regeln ändern:** `firebase deploy --only firestore`.

**Kostenlos-Grenzen (Spark):** 50.000 Lesevorgänge und 20.000 Schreibvorgänge pro Tag, 1 GB Speicher,
10 GB Datenübertragung pro Monat – reicht für einige Tausend Fotos/PDFs.

## Geplant

- **Paletten-Erfassung:** fertige Palette pro Auftrag notieren, Tagesübersicht am Abend (weitere Sammlung `pallets`).
