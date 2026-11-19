# BO-WERT Konfektionierung

Handy-Web-App für die Konfektionierung: Zu einer **Auftragsnummer** sofort sehen, welcher **Artikel** dazugehört,
welche **Materialien** gebraucht werden und **wo sie im Lager liegen** – und entnommenes Material direkt auf die
**Bestellliste** setzen. Alle Mitarbeiter arbeiten mit denselben Daten.

**App:** https://steffenkastian.github.io/bowert-konfektionierung/ · Passwort: `bowert`
**Abrechnung:** https://steffenkastian.github.io/bowert-konfektionierung/abrechnung/ · eigenes langes Passwort (nicht hier notiert)

## Struktur

```
Auftragsnummer  ──►  Artikelbezeichnung (z. B. „5er“, „200er“)  ──►  Materialien (Artikelnummern)
 ├─ Bestellnummer, Satz im Auftrag  ├─ Satz pro Palette                ├─ Beschreibung (optional)
 └─ gesammelte Paletten ──► Lieferschein      └─ Packhinweise, Lieferschein-Text  └─ Lagerort (optional)
```

Auftragsnummern werden nur mit den 6 Ziffern gepflegt (z. B. `231084`); auf dem Lieferschein steht `630-231084`.

Ein Material (Artikelnummer) wird nur einmal gepflegt. Ändert sich sein Lagerort, gilt das für alle Artikel.

## Bedienung

| Bereich | Wofür |
| --- | --- |
| **Suche** (Start) | Auftragsnummer, Artikelbezeichnung, Artikelnummer oder Lagerort eintippen. „202878“ findet auch „630-202878X“. **123** schaltet auf die Zahlentastatur. |
| **Aufträge** | Status je Auftrag: **Nicht begonnen · Als nächstes · In Arbeit · Abgeschlossen** (auf der Auftragsseite mit einem Tipp umschalten, Liste danach filtern, „In Arbeit“ und „Als nächstes“ stehen auch auf der Startseite). **Als nächstes** wird an einen laufenden Auftrag gekoppelt: Am laufenden Auftrag den nächsten wählen (oder neu anlegen) – dort steht dann „Als nächstes: …“ mit **Starten**-Knopf, in Listen „→ danach …“. Beim Abschließen bietet die App an, den nächsten direkt zu starten. Auftrag anlegen und Artikelbezeichnung zuordnen – beim Tippen („5“) werden passende Artikel vorgeschlagen, inkl. Vorschau der Materialien. Unbekannte Bezeichnungen werden neu angelegt. |
| **Fertig melden** | Auf der Auftragsseite **1 Palette** (= Satz pro Palette des Artikels) oder **Andere Menge** (Satz + Paletten). Die Paletten werden **gesammelt**, bis Lieferscheine erstellt werden – danach wird neu gesammelt. Fortschritt „x von y Satz“ steht am Auftrag und in der Auftragsliste. |
| **Lieferscheine** | Oben das Gesammelte (je Auftrag), darunter die heute erstellten Lieferscheine (mit ‹ › frühere Tage). **Lieferscheine erstellen** macht aus allem Gesammelten je Auftrag einen Lieferschein mit dem **Datum dieses Tages** (auch mehrmals am Tag möglich – dann gibt es mehrere Lieferscheine je Auftrag) und vergibt fortlaufende Nummern (JJJJ + laufende Nummer, im neuen Jahr ab JJJJ0001; nächste Nummer unter ⚙ änderbar). **PDF teilen / drucken** erzeugt alle Lieferscheine des Tages als eine PDF im Layout der alten Word-Vorlage. Sind unter ⚙ Mailversand und „Automatisch senden an“ eingetragen, gehen neue Lieferscheine beim Erstellen **automatisch per Mail** raus (je Lieferschein ein PDF, max. 5 pro Mail). Status je Schein: *nicht verschickt · verschickt · geändert* (geänderte als „korrigierte Fassung“ neu senden). Wird danach noch etwas geändert, ist der Lieferschein als „geändert“ markiert und kann mit derselben Nummer neu verschickt werden. **Alle Lieferscheine**: Liste mit Filter und Export als Tabelle (CSV). |
| **Artikel** | Umschalter **Artikel / Material** oben. Satz pro Palette und Text auf dem Lieferschein (leer = „Konfektionierung - Artikelbezeichnung“). Materialien per Artikelnummer zuordnen. Bekannte Nummern füllen Beschreibung und Lagerort automatisch aus. **Packhinweise:** Foto (direkt mit der Kamera) oder PDF hochladen – erscheint bei jedem Auftrag mit diesem Artikel. Antippen zeigt Foto bzw. alle PDF-Seiten in der App; umbenennen, teilen, löschen. |
| **Bestellliste** | Überall, wo ein Lagerort steht, gibt es **Entnehmen** → das Material landet hier (mehrfach tippen = Menge +1). Menge anpassen, als *bestellt* markieren, bei Eintreffen abhaken, Liste per WhatsApp/Mail **teilen**. **Umlagerungsschein:** füllt die Excel-Vorlage aus (Menge = Anzahl Paletten in Spalte A bei der passenden Teile-Nr.; unbekannte Teile-Nr. werden unten angehängt) – **Per Mail senden** (iPhone: Teilen-Menü; Android/Computer: Excel wird gespeichert und die Mail-App mit Empfänger + Betreff geöffnet – Datei dort anhängen) oder als Excel speichern, danach optional alles als bestellt markieren. |
| ⚙ **Mehr** | Nächste Lieferscheinnummer, Umlagerungsschein-Vorlage (.xlsx) hochladen/ersetzen + Mail-Empfänger, Datenbestand, Sicherungskopie (JSON), Anleitung „Als App installieren“, Abmelden. |

## Abrechnung (eigene App)

Unter `/abrechnung/` läuft dieselbe App mit eigenem Konto `abrechnung@bowert-gmbh.de` (langes Zufallspasswort).
Sie zeigt alle Daten der Konfektionierung (Aufträge, Artikel, Lieferscheine, über ⚙ auch Suche/Material/Bestellliste)
und zusätzlich:

| Bereich | Wofür |
| --- | --- |
| **Umsatz** (Start) | Monat mit ‹ › wählen: Umsatz netto (Monat, heute bzw. Vormonat, Jahr), Balken je Tag und je Monat (antippen = Wert), Tabelle je Artikel. Umsatz = fertig gemeldete Satz × Preis am Liefertag. Satz ohne Preis werden gemeldet. |
| **Preise** | Am Artikel: Nettopreis pro Satz mit **gültig ab**. Frühere Lieferungen behalten ihren alten Preis; Preise, die schon abgerechnet sind, lassen sich nicht mehr rückwirkend ändern. Unter **Preise → Alle Preise erhöhen**: Prozent + Stichtag, Vorschau „bisher → neu“, gilt für alle Artikel mit Preis (Basis: Preis am Vortag, 4 Nachkommastellen), mit Rückgängig. |
| **Rechnungen** | Zeitraum wählen (Monate mit offenen Lieferscheinen stehen oben). **Je Auftrag eine Rechnung**: Aufträge an-/abwählen, Aufträge ohne Preis werden übersprungen. Erste Nummer prüfen, die weiteren laufen fortlaufend in der Reihenfolge der Aufträge. Je Rechnung eine PDF (Rechnung im Layout von `pdf.py`, dahinter genau die archivierten Lieferscheine); mehrere kommen als **ZIP**. Im Archiv (nach Monat) gibt es je Monat „ZIP“ zum erneuten Herunterladen. Der Nummernkreis wird auch für andere Rechnungen benutzt – Nummern bitte prüfen. |
| **Storno** | An der Rechnung: erzeugt eine Stornorechnung (eigene Nummer, negative Beträge); die Lieferscheine werden wieder frei. |

Abgerechnete Lieferscheine sind **gesperrt** (keine Einträge, kein Löschen) – auch in der Datenbank-Regel.
Gespeichert wird: `prices/{Artikel}`, `invoices/{Nummer}` (eingefrorene Positionen, Summen, Lieferscheine mit Fassung),
`invoicePdfs/{Nummer}` (die Rechnungsseite), `billing/settings`. Diese Sammlungen kann nur das Abrechnungs-Konto lesen.

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
js/lieferschein.js     Lieferschein-PDF (Nachbau der Word-Vorlage, Koordinaten aus der alten PDF)
js/umlagerung.js       Umlagerungsschein: füllt die Excel-Vorlage auf XML-Ebene aus (Rest bleibt unverändert)
js/abrechnung.js       Abrechnung: Umsatz-Dashboard, Preise, Rechnungen (nur in /abrechnung/ geladen)
js/rechnung.js         Rechnungs-PDF (Nachbau von pdf.py) + Zusammenfügen mit den Lieferscheinen
abrechnung/            Einstieg der Abrechnungs-App (index.html, Manifest, Logo für die Rechnung)
vendor/pdf-lib/        pdf-lib 1.17.1 (MIT) zum Zusammenfügen von PDFs
vendor/pdfjs/          pdf.js 4.10.38 (Mozilla, Apache-2.0) zum Anzeigen von PDFs
vendor/jspdf/          jsPDF 3.0.3 (MIT) zum Erzeugen der Lieferscheine
vendor/fonts/          Caladea (OFL) – maßgleich zu Cambria aus der Word-Vorlage
vendor/fflate/         fflate 0.8.2 (MIT) zum Lesen/Schreiben der .xlsx-Datei
sw.js                  Service Worker (App-Dateien offline)
firestore.rules        Zugriffsregeln der Datenbank
```

**Neue Version veröffentlichen:** committen und pushen, vorher in `sw.js` die Konstante `CACHE` hochzählen
(z. B. `konf-v11`), damit installierte Apps die neuen Dateien laden.
**Regeln ändern:** `firebase deploy --only firestore`.

**Kostenlos-Grenzen (Spark):** 50.000 Lesevorgänge und 20.000 Schreibvorgänge pro Tag, 1 GB Speicher,
10 GB Datenübertragung pro Monat – reicht für einige Tausend Fotos/PDFs.

## Mailversand (Gmail-Arbeitskonto)

Umlagerungsscheine gehen mit **Jetzt senden** direkt aus der App raus – ohne Mail-Programm. Dafür läuft ein kleines
Google-Apps-Script im Gmail-Arbeitskonto ([`mail/Code.gs`](mail/Code.gs)), das die Mail mit Anhang verschickt.

**Einrichtung (einmalig, am Computer, im Gmail-Arbeitskonto angemeldet):**
1. https://script.google.com → **Neues Projekt** → den Inhalt von `mail/Code.gs` komplett einfügen → Speichern.
2. **Bereitstellen → Neue Bereitstellung** → Zahnrad: **Web-App**. *Ausführen als:* **Ich**, *Zugriff:* **Jeder** → Bereitstellen.
3. Berechtigungen bestätigen (bei „Google hat diese App nicht überprüft“: *Erweitert → Zu … wechseln*).
4. Die **Web-App-URL** (endet auf `/exec`) in der App unter ⚙ Mehr → **Mailversand** eintragen → **Verbindung testen**.
5. Unter ⚙ Mehr → Umlagerungsschein den **Mail-Empfänger** eintragen (mehrere mit Komma).

Sicherheit: Die App schickt ihr Anmelde-Token mit, das Skript lässt es von Google prüfen und verschickt nur für das
Konten der App (Team und Abrechnung). Die Skript-URL steht nur in der (geschützten) Datenbank, nicht im öffentlichen Code.
Gmail erlaubt ca. 100 Empfänger pro Tag. Wird `Code.gs` geändert: *Bereitstellungen verwalten → Bearbeiten →
Neue Version* (die URL bleibt gleich).

## Daten der Lieferscheine

**Archiv (für die Abrechnung):** Jede verschickte, geteilte oder gedruckte Fassung wird **genau so gespeichert, wie
sie rausging** – als PDF plus eingefrorene Daten (Nummer, Auftrag, Bestellnummer, Text, Mengen, „bisher geliefert“).
Spätere Änderungen an Artikeln oder Aufträgen ändern einen verschickten Lieferschein nicht mehr. Wird nachträglich
korrigiert, entsteht Fassung 2, 3 … (alle bleiben im Archiv). Für Rechnungen werden die archivierten PDFs angehängt.

- `deliveries/{Auftrag}_offen`: gesammelte Einträge (Satz, Paletten, Zeit) eines Auftrags, noch ohne Lieferschein.
- `deliveries/{Auftrag}_{Datum}` (weitere am selben Tag `_2`, `_3` …): Lieferschein mit Nummer, entsteht beim Erstellen aus dem Gesammelten.
  Menge und Paletten ergeben sich immer aus den Einträgen. „Gesamtliefermenge bisher“ = Summe der Lieferscheine
  dieses Auftrags davor (am selben Tag: mit kleinerer Nummer).
- `archive/{Lieferschein}_v{n}`: archiviertes PDF (~25 KB) + eingefrorene Daten je Fassung; wird nur bei Bedarf geladen.
- `settings/lieferschein`: nächste freie Nummer und Empfänger für den automatischen Versand. Vergabe per Firestore-Transaktion (keine doppelten Nummern,
  braucht Internetverbindung).
- `settings/mail`: Web-App-URL des Mail-Skripts.
- `settings/umlagerung`: Excel-Vorlage des Umlagerungsscheins (nicht im öffentlichen Repo, da Kundenformular)
  und optional der Mail-Empfänger. Geändert werden beim Ausfüllen nur Spalte A, die ausgeblendeten Zeilen
  (Autofilter auf Spalte A) und der gespeicherte Wert der Datumsformel in C6.
- Der Ordner `AlteVorlagen/` (altes Python-Skript, enthält Zugangsdaten) ist per `.gitignore` ausgeschlossen.
