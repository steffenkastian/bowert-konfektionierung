/**
 * BO-WERT Konfektionierung – Mailversand über das Gmail-Arbeitskonto
 *
 * Einrichtung (einmalig, im Gmail-Arbeitskonto angemeldet):
 *   1. https://script.google.com → „Neues Projekt“ → diesen Code komplett einfügen → Speichern
 *   2. „Bereitstellen“ → „Neue Bereitstellung“ → Typ „Web-App“
 *        Ausführen als: Ich        Zugriff: Jeder
 *   3. Berechtigungen bestätigen („E-Mails in Ihrem Namen senden“, „Mit externem Dienst verbinden“)
 *   4. Die Web-App-URL (endet auf /exec) in der App unter ⚙ Mehr → „Mailversand“ eintragen
 *
 * Sicherheit: Die App schickt ihr Anmelde-Token mit. Das Skript lässt es von Google prüfen und
 * verschickt nur, wenn es zu einem Konto der App gehört. Ohne gültige Anmeldung passiert nichts.
 */

const FIREBASE_API_KEY = 'AIzaSyBtfSW3aUZBWwwSNYiPE5IYizSrg386HGE';
// Konten der App, die verschicken dürfen (Konfektionierung und Abrechnung)
const APP_KONTEN = ['konfektionierung@bowert-gmbh.de', 'abrechnung@bowert-gmbh.de'];
const ABSENDER_NAME = 'BO-WERT Konfektionierung';
const MAX_EMPFAENGER = 5;
const MAX_ANHANG_BYTES = 8 * 1024 * 1024;
const MAX_ANHAENGE = 10;

/** Verbindungstest aus der App (ohne Mailversand). */
function doGet() {
  return antwort({ ok: true, dienst: 'bowert-mail', version: 1, absender: Session.getEffectiveUser().getEmail() });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    pruefeAnmeldung(req.idToken);

    if (req.test) {
      return antwort({ ok: true, test: true, absender: Session.getEffectiveUser().getEmail(), restKontingent: MailApp.getRemainingDailyQuota() });
    }

    const empfaenger = String(req.to || '').split(/[,;\s]+/).filter(Boolean);
    if (!empfaenger.length) throw new Error('Kein Empfänger angegeben.');
    if (empfaenger.length > MAX_EMPFAENGER) throw new Error('Zu viele Empfänger (max. ' + MAX_EMPFAENGER + ').');
    empfaenger.forEach(function (a) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw new Error('Ungültige Adresse: ' + a);
    });
    const betreff = String(req.subject || '').slice(0, 200);
    if (!betreff) throw new Error('Kein Betreff.');

    if ((req.attachments || []).length > MAX_ANHAENGE) throw new Error('Zu viele Anhänge (max. ' + MAX_ANHAENGE + ').');
    const anhaenge = (req.attachments || []).map(function (a) {
      const bytes = Utilities.base64Decode(String(a.data || ''));
      if (bytes.length > MAX_ANHANG_BYTES) throw new Error('Anhang zu groß: ' + a.name);
      return Utilities.newBlob(bytes, String(a.mimeType || 'application/octet-stream'), String(a.name || 'Anhang'));
    });

    MailApp.sendEmail({
      to: empfaenger.join(','),
      subject: betreff,
      body: String(req.body || '').slice(0, 20000),
      name: ABSENDER_NAME,
      attachments: anhaenge,
    });
    return antwort({ ok: true, an: empfaenger, restKontingent: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return antwort({ ok: false, fehler: String((err && err.message) || err) });
  }
}

/** Prüft bei Google, ob das Token gültig ist und zu einem Konto der App gehört. */
function pruefeAnmeldung(idToken) {
  if (!idToken) throw new Error('Nicht angemeldet.');
  const res = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error('Anmeldung ungültig – bitte in der App neu anmelden.');
  const daten = JSON.parse(res.getContentText());
  const nutzer = daten.users && daten.users[0];
  if (!nutzer || APP_KONTEN.indexOf(nutzer.email) < 0) throw new Error('Keine Berechtigung.');
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
