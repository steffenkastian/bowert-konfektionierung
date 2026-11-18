// Firebase-Projekt „bowert-konfektionierung“ (Region Frankfurt).
// Diese Werte sind öffentlich (stehen in jeder Firebase-Web-App) – geschützt wird über
// den Login und die Regeln in firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyBtfSW3aUZBWwwSNYiPE5IYizSrg386HGE',
  authDomain: 'bowert-konfektionierung.firebaseapp.com',
  projectId: 'bowert-konfektionierung',
  storageBucket: 'bowert-konfektionierung.firebasestorage.app',
  messagingSenderId: '995388441341',
  appId: '1:995388441341:web:8eef67b9ba4eb652ab7494',
};

// Gemeinsames Team-Konto. In der App wird nur das Passwort eingegeben.
export const TEAM_EMAIL = 'konfektionierung@bowert-gmbh.de';

// Abrechnungs-Konto (eigene Adresse /abrechnung/, eigenes langes Passwort). Darf alles, was das Team darf,
// und zusätzlich Preise, Umsätze und Rechnungen – die sind für das Team-Konto gesperrt (firestore.rules).
export const BILLING_EMAIL = 'abrechnung@bowert-gmbh.de';
/** true in der Abrechnungs-App (abrechnung/index.html setzt data-mode="abrechnung"). */
export const IS_BILLING = document.documentElement.dataset.mode === 'abrechnung';
