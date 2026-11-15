# BO-WERT Konfektionierung

Handy-Web-App für die Konfektionierung: Zu einer **Auftragsnummer** sofort sehen, welche **Artikel** dazugehören,
welches **Verpackungsmaterial** sie brauchen und **wo es im Lager liegt**.

**App:** https://steffenkastian.github.io/bowert-konfektionierung/

## Bedienung

| Bereich | Wofür |
| --- | --- |
| **Suche** (Start) | Auftragsnummer, ArtikelID, Materialnummer oder Lagerort eintippen. Treffer zeigen Material + Lagerort direkt. „202878“ findet auch „630-202878X“. Mit **123** auf die Zahlentastatur umschalten. |
| **Aufträge** | Auftrag anlegen, ArtikelID(s) zuordnen. Unbekannte ArtikelIDs werden automatisch angelegt. Bei mehreren Artikeln: Ansicht **„Nach Lagerort“** = Pickliste in Laufreihenfolge. |
| **Artikel** | Pro Artikel die Verpackungsmaterialien hinterlegen (Nummer, Bezeichnung, Lagerort, Menge). „Speichern & nächstes Material“ für schnelle Eingabe. |
| **Material** | Alle Materialien mit Lagerort. Ein Lagerort wird nur einmal gepflegt und gilt für alle Artikel, die das Material nutzen. |
| **Mehr** | Backup speichern/einspielen, Anleitung „Als App installieren“, Abmelden. |

Passwort: `bowert` (Groß-/Kleinschreibung egal). Die Anmeldung bleibt auf dem Gerät gespeichert.

## Wichtig zu wissen

- **Daten liegen nur auf dem Gerät** (localStorage im Browser), nicht im Internet und nicht in diesem Repository.
  Regelmäßig unter *Mehr → Backup speichern* sichern. Mit der Backup-Datei lassen sich Daten auf ein anderes Gerät übertragen.
- **iPhone:** Eine zum Home-Bildschirm hinzugefügte App hat einen **eigenen Speicher**, getrennt von Safari.
  Am besten zuerst installieren, dann Daten eintragen.
- **Passwort ist nur ein Sichtschutz.** Der Code auf GitHub Pages ist öffentlich; das Passwort hält Neugierige fern,
  schützt aber nicht vor jemandem, der den Quelltext liest. Die Auftragsdaten selbst sind nie öffentlich (sie liegen nur auf dem Handy).
- **Offline-fähig:** Nach dem ersten Öffnen funktioniert die App auch ohne Empfang.

## Technik

Reines HTML/CSS/JavaScript ohne Build-Schritt – läuft direkt auf GitHub Pages.

```
index.html             Grundgerüst (Login, Kopfzeile, Tab-Leiste)
css/app.css            Gestaltung (mobil zuerst, Hell/Dunkel)
js/app.js              Routing, Login, alle Ansichten
js/store.js            Datenmodell + Speicherung (localStorage), Backup
js/ui.js               Helfer: Suche, Sortierung, Icons, Vorschlagslisten
sw.js                  Service Worker (Offline-Cache)
manifest.webmanifest   App-Installation (PWA)
```

Datenmodell (`js/store.js`):

```
materials: { id, nr, name, location }               Stammdaten, Lagerort gilt überall
articles:  { id, code, name, items: [{ materialId, qty }] }
orders:    { id, nr, note, articleIds: [] }
```

**Neue Version veröffentlichen:** Änderungen committen und pushen. Danach in `sw.js` die Konstante `CACHE`
hochzählen (z. B. `konf-v2`), damit installierte Apps die neuen Dateien laden.

Lokal testen: `python -m http.server 8000` im Ordner starten und http://localhost:8000 öffnen
(der Service Worker ist lokal absichtlich aus).

## Geplant

- **Paletten-Erfassung:** fertige Palette pro Auftrag mit einem Tipp notieren, Tagesübersicht am Abend
  (Datenmodell ist dafür vorbereitet: `pallets` kommt als weitere Liste dazu).
