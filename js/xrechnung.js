// E-Rechnung im Format XRechnung 3.0 (Syntax UBL 2.1).
// Rechnung → ubl:Invoice (380), Stornorechnung → ubl:CreditNote (381) mit Verweis auf die Rechnung.
// Die PDF (Rechnung + Lieferscheine) wird als Anhang eingebettet.
//
// Reine Textausgabe ohne Browser-Abhängigkeit (außer btoa) – dadurch auch in Node prüfbar.

export const SELLER = {
  name: 'BO-WERT GmbH',
  street: 'Im Dreieck 4',
  zip: '23758',
  city: 'Oldenburg i.H.',
  vatId: 'DE154623848',
  taxNo: '222 981 62 22',
  register: 'HRB 6601 HL',
  legalInfo: 'Ag. HRB 6601 HL, Geschäftsführer: Michael Bollmann',
  email: 'info@bowert-entsorgung.de',
  accounts: [
    { iban: 'DE39213522400004003224', bic: 'NOLADE21HOL', bank: 'Sparkasse Holstein' },
    { iban: 'DE59213922180000724742', bic: 'GENODEF1EUT', bank: 'Volksbank Eutin Raiffeisenbank eG' },
  ],
};

export const BUYER = {
  name: 'Eppendorf Polymere GmbH',
  street: 'Barkhausenweg 1',
  extra: 'Finanzbuchhaltung c/o EPPENDORF AG',
  zip: '22339',
  city: 'Hamburg',
  email: '630invoices@eppendorf.de',
  delivery: { name: 'Eppendorf Polymere GmbH', street: 'Sebenter Weg 39', zip: '23758', city: 'Oldenburg' },
};

export const PAYMENT_DAYS = 14;
const VAT_PERCENT = 19;
const UNIT = 'SET'; // UN/ECE Rec. 20: „Satz“

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (n) => (Math.round((Math.abs(Number(n)) + Number.EPSILON) * 100) / 100).toFixed(2);
/** Menge/Preis ohne unnötige Nullen, Punkt als Dezimalzeichen. */
const num = (n, digits = 4) => String(Number(Math.abs(Number(n)).toFixed(digits)));
const fmtNo = (no) => { const t = String(no || ''); return t.length === 8 ? `${t.slice(0, 4)} ${t.slice(4)}` : t; };
const deDate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Uint8Array → Base64 (in Stücken, damit große PDFs den Aufruf-Stack nicht sprengen). */
function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Fehlende Pflichtangaben für die E-Rechnung (leer = alles da). */
export function missingContact(c) {
  const out = [];
  if (!c?.name) out.push('Name');
  if (!c?.phone) out.push('Telefon');
  if (!c?.email) out.push('E-Mail');
  return out;
}

const address = (a, extra = '') => `<cac:PostalAddress>
        <cbc:StreetName>${esc(a.street)}</cbc:StreetName>${extra ? `
        <cbc:AdditionalStreetName>${esc(extra)}</cbc:AdditionalStreetName>` : ''}
        <cbc:CityName>${esc(a.city)}</cbc:CityName>
        <cbc:PostalZone>${esc(a.zip)}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>`;

const taxCategory = (tag) => `<cac:${tag}>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${VAT_PERCENT}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:${tag}>`;

/**
 * XRechnung als Text.
 * @param {object} inv  eingefrorene Rechnung aus store (no, type, date, from, to, lieferdatum, items, netto, ust, brutto,
 *                      orderNrs, bestellnrs, deliveries, extraLine, note, refNo)
 * @param {object} o
 * @param {{name:string, phone:string, email:string}} o.contact  Ansprechpartner bei BO-WERT
 * @param {Uint8Array} [o.pdf]       PDF zum Einbetten
 * @param {string} [o.pdfName]
 * @param {string} [o.refDate]       Datum der stornierten Rechnung (nur Storno)
 * @param {(item) => string} [o.artNrOf]  Artikelnummer des Kunden, falls nicht in der Position gespeichert
 */
export function xrechnungXml(inv, { contact, pdf, pdfName = 'Rechnung.pdf', refDate = '', artNrOf = () => '' } = {}) {
  const miss = missingContact(contact);
  if (miss.length) throw new Error(`Für die E-Rechnung fehlt beim Ansprechpartner: ${miss.join(', ')}.`);
  const credit = inv.type === 'storno';
  const root = credit ? 'CreditNote' : 'Invoice';
  const lineTag = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = credit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const bestell = (inv.bestellnrs || []).filter(Boolean);
  const orderNrs = (inv.orderNrs || []).filter(Boolean);
  // Käuferreferenz (Pflicht): die Bestellnummer von Eppendorf
  const buyerRef = bestell.join(', ') || (orderNrs.length ? `Auftrag ${orderNrs.join(', ')}` : fmtNo(inv.no));
  const due = credit ? '' : addDays(inv.date, PAYMENT_DAYS);

  const notes = [];
  if (credit) notes.push(`Stornorechnung zur Rechnung Nr. ${fmtNo(inv.refNo)}${refDate ? ` vom ${deDate(refDate)}` : ''}.`);
  if (inv.extraLine) notes.push(inv.extraLine);
  if (orderNrs.length) notes.push(`${orderNrs.length > 1 ? 'Aufträge' : 'Auftrag'}: ${orderNrs.join(', ')}`);
  const lsNos = (inv.deliveries || []).map((d) => d.no).filter(Boolean);
  if (lsNos.length) notes.push(`${lsNos.length > 1 ? 'Lieferscheine' : 'Lieferschein'}: ${lsNos.join(', ')}`);
  if (inv.note) notes.push(inv.note);

  const lines = inv.items.map((it, i) => {
    const artNr = it.artNr || artNrOf(it) || '';
    return `<cac:${lineTag}>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:${qtyTag} unitCode="${UNIT}">${num(it.qty)}</cbc:${qtyTag}>
    <cbc:LineExtensionAmount currencyID="EUR">${amt(it.total)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(it.text || 'Konfektionierung')}</cbc:Name>${artNr ? `
      <cac:BuyersItemIdentification><cbc:ID>${esc(artNr)}</cbc:ID></cac:BuyersItemIdentification>` : ''}
      ${taxCategory('ClassifiedTaxCategory')}
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">${num(it.price)}</cbc:PriceAmount></cac:Price>
  </cac:${lineTag}>`;
  }).join('\n  ');

  // Storno: Pflichtangabe BG-16 als „Verrechnung zwischen Partnern“ (UNTDID 4461: 97)
  const payment = credit
    ? `<cac:PaymentMeans>
    <cbc:PaymentMeansCode name="Verrechnung">97</cbc:PaymentMeansCode>
  </cac:PaymentMeans>`
    : SELLER.accounts.map((a) => `<cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${a.iban}</cbc:ID>
      <cbc:Name>${esc(SELLER.name)}</cbc:Name>
      <cac:FinancialInstitutionBranch><cbc:ID>${a.bic}</cbc:ID></cac:FinancialInstitutionBranch>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>`).join('\n  ');
  const terms = credit
    ? 'Gutschrift durch Stornierung – wird mit der stornierten Rechnung verrechnet.'
    : `Die Rechnung ist fällig in ${PAYMENT_DAYS} Tagen (bis ${deDate(due)}).`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<ubl:${root} xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${esc(inv.no)}</cbc:ID>
  <cbc:IssueDate>${esc(inv.date)}</cbc:IssueDate>${due ? `
  <cbc:DueDate>${due}</cbc:DueDate>` : ''}
  <cbc:${root}TypeCode>${credit ? 381 : 380}</cbc:${root}TypeCode>
  ${notes.map((n) => `<cbc:Note>${esc(n)}</cbc:Note>`).join('\n  ')}
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${esc(buyerRef)}</cbc:BuyerReference>${inv.from && inv.to ? `
  <cac:InvoicePeriod>
    <cbc:StartDate>${esc(inv.from)}</cbc:StartDate>
    <cbc:EndDate>${esc(inv.to)}</cbc:EndDate>
  </cac:InvoicePeriod>` : ''}${bestell.length === 1 ? `
  <cac:OrderReference><cbc:ID>${esc(bestell[0])}</cbc:ID></cac:OrderReference>` : ''}${credit ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(inv.refNo)}</cbc:ID>${refDate ? `
      <cbc:IssueDate>${esc(refDate)}</cbc:IssueDate>` : ''}
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>` : ''}${pdf ? `
  <cac:AdditionalDocumentReference>
    <cbc:ID>${esc(pdfName)}</cbc:ID>
    <cbc:DocumentDescription>${credit ? 'Stornorechnung als PDF' : 'Rechnung mit Lieferscheinen als PDF'}</cbc:DocumentDescription>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="${esc(pdfName)}">${base64(pdf)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>` : ''}
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">${esc(SELLER.email)}</cbc:EndpointID>
      <cac:PartyName><cbc:Name>${esc(SELLER.name)}</cbc:Name></cac:PartyName>
      ${address(SELLER)}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(SELLER.vatId)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(SELLER.taxNo)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(SELLER.name)}</cbc:RegistrationName>
        <cbc:CompanyID>${esc(SELLER.register)}</cbc:CompanyID>
        <cbc:CompanyLegalForm>${esc(SELLER.legalInfo)}</cbc:CompanyLegalForm>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Name>${esc(contact.name)}</cbc:Name>
        <cbc:Telephone>${esc(contact.phone)}</cbc:Telephone>
        <cbc:ElectronicMail>${esc(contact.email)}</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">${esc(BUYER.email)}</cbc:EndpointID>
      <cac:PartyName><cbc:Name>${esc(BUYER.name)}</cbc:Name></cac:PartyName>
      ${address(BUYER, BUYER.extra)}
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(BUYER.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:Delivery>${inv.lieferdatum ? `
    <cbc:ActualDeliveryDate>${esc(inv.lieferdatum)}</cbc:ActualDeliveryDate>` : ''}
    <cac:DeliveryLocation>
      <cac:Address>
        <cbc:StreetName>${esc(BUYER.delivery.street)}</cbc:StreetName>
        <cbc:CityName>${esc(BUYER.delivery.city)}</cbc:CityName>
        <cbc:PostalZone>${esc(BUYER.delivery.zip)}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:Address>
    </cac:DeliveryLocation>
    <cac:DeliveryParty><cac:PartyName><cbc:Name>${esc(BUYER.delivery.name)}</cbc:Name></cac:PartyName></cac:DeliveryParty>
  </cac:Delivery>
  ${payment}
  <cac:PaymentTerms><cbc:Note>${esc(terms)}</cbc:Note></cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">${amt(inv.ust)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">${amt(inv.netto)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">${amt(inv.ust)}</cbc:TaxAmount>
      ${taxCategory('TaxCategory')}
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">${amt(inv.netto)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">${amt(inv.netto)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${amt(inv.brutto)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${amt(inv.brutto)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lines}
</ubl:${root}>
`;
}

// ======================================================================
// Lesen: XRechnung (UBL Invoice / CreditNote) → einfache Daten für die Vorschau
// ======================================================================

/** Kinder-Elemente nach lokalem Namen (Namensräume egal). */
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
/** Pfad aus lokalen Namen, z. B. at(party, 'PostalAddress', 'CityName') */
const at = (el, ...path) => path.reduce((e, n) => kids(e, n)[0] || null, el);
const val = (el, ...path) => at(el, ...path)?.textContent.trim() || '';
const numv = (el, ...path) => { const t = val(el, ...path); return t === '' ? null : Number(t); };

function readParty(p) {
  if (!p) return null;
  const addr = at(p, 'PostalAddress');
  const taxSchemes = kids(p, 'PartyTaxScheme').map((t) => ({ id: val(t, 'CompanyID'), scheme: val(t, 'TaxScheme', 'ID') }));
  return {
    name: val(p, 'PartyName', 'Name') || val(p, 'PartyLegalEntity', 'RegistrationName'),
    legalName: val(p, 'PartyLegalEntity', 'RegistrationName'),
    endpoint: val(p, 'EndpointID'),
    endpointScheme: at(p, 'EndpointID')?.getAttribute('schemeID') || '',
    address: addr ? {
      street: val(addr, 'StreetName'), extra: val(addr, 'AdditionalStreetName'),
      zip: val(addr, 'PostalZone'), city: val(addr, 'CityName'), country: val(addr, 'Country', 'IdentificationCode'),
    } : null,
    vatId: taxSchemes.find((t) => t.scheme === 'VAT')?.id || '',
    taxNo: taxSchemes.find((t) => t.scheme !== 'VAT')?.id || '',
    registerId: val(p, 'PartyLegalEntity', 'CompanyID'),
    legalInfo: val(p, 'PartyLegalEntity', 'CompanyLegalForm'),
    contact: at(p, 'Contact')
      ? { name: val(p, 'Contact', 'Name'), phone: val(p, 'Contact', 'Telephone'), email: val(p, 'Contact', 'ElectronicMail') }
      : null,
  };
}

/** XML-Text → Daten. Wirft einen Fehler, wenn es keine UBL-Rechnung/-Gutschrift ist. */
export function readXrechnung(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Die Datei ist kein gültiges XML.');
  const r = doc.documentElement;
  if (!['Invoice', 'CreditNote'].includes(r.localName)) throw new Error('Keine XRechnung im UBL-Format (Invoice/CreditNote).');
  const credit = r.localName === 'CreditNote';
  const delivery = at(r, 'Delivery');
  const dAddr = at(delivery, 'DeliveryLocation', 'Address');
  const total = at(r, 'LegalMonetaryTotal');
  return {
    credit,
    customization: val(r, 'CustomizationID'),
    typeCode: val(r, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'),
    id: val(r, 'ID'),
    issueDate: val(r, 'IssueDate'),
    dueDate: val(r, 'DueDate') || val(r, 'PaymentMeans', 'PaymentDueDate'),
    currency: val(r, 'DocumentCurrencyCode') || 'EUR',
    notes: kids(r, 'Note').map((n) => n.textContent.trim()).filter(Boolean),
    buyerRef: val(r, 'BuyerReference'),
    period: at(r, 'InvoicePeriod') ? { start: val(r, 'InvoicePeriod', 'StartDate'), end: val(r, 'InvoicePeriod', 'EndDate') } : null,
    orderRef: val(r, 'OrderReference', 'ID'),
    billingRefs: kids(r, 'BillingReference').map((b) => ({ id: val(b, 'InvoiceDocumentReference', 'ID'), date: val(b, 'InvoiceDocumentReference', 'IssueDate') })),
    attachments: kids(r, 'AdditionalDocumentReference').map((a) => {
      const obj = at(a, 'Attachment', 'EmbeddedDocumentBinaryObject');
      return {
        id: val(a, 'ID'), description: val(a, 'DocumentDescription'),
        filename: obj?.getAttribute('filename') || val(a, 'ID'), mime: obj?.getAttribute('mimeCode') || '',
        base64: obj ? obj.textContent.replace(/\s+/g, '') : '',
      };
    }),
    seller: readParty(at(r, 'AccountingSupplierParty', 'Party')),
    buyer: readParty(at(r, 'AccountingCustomerParty', 'Party')),
    delivery: delivery ? {
      date: val(delivery, 'ActualDeliveryDate'),
      name: val(delivery, 'DeliveryParty', 'PartyName', 'Name'),
      address: dAddr ? { street: val(dAddr, 'StreetName'), zip: val(dAddr, 'PostalZone'), city: val(dAddr, 'CityName'), country: val(dAddr, 'Country', 'IdentificationCode') } : null,
    } : null,
    payment: kids(r, 'PaymentMeans').map((m) => ({
      code: val(m, 'PaymentMeansCode'), name: at(m, 'PaymentMeansCode')?.getAttribute('name') || '',
      iban: val(m, 'PayeeFinancialAccount', 'ID'), accountName: val(m, 'PayeeFinancialAccount', 'Name'),
      bic: val(m, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID'), reference: val(m, 'PaymentID'),
    })),
    terms: val(r, 'PaymentTerms', 'Note'),
    taxAmount: numv(r, 'TaxTotal', 'TaxAmount'),
    taxes: kids(at(r, 'TaxTotal'), 'TaxSubtotal').map((t) => ({
      taxable: numv(t, 'TaxableAmount'), amount: numv(t, 'TaxAmount'),
      category: val(t, 'TaxCategory', 'ID'), percent: numv(t, 'TaxCategory', 'Percent'),
      reason: val(t, 'TaxCategory', 'TaxExemptionReason'),
    })),
    totals: {
      lines: numv(total, 'LineExtensionAmount'), net: numv(total, 'TaxExclusiveAmount'), gross: numv(total, 'TaxInclusiveAmount'),
      allowances: numv(total, 'AllowanceTotalAmount'), charges: numv(total, 'ChargeTotalAmount'),
      prepaid: numv(total, 'PrepaidAmount'), payable: numv(total, 'PayableAmount'),
    },
    lines: kids(r, credit ? 'CreditNoteLine' : 'InvoiceLine').map((l) => {
      const q = at(l, credit ? 'CreditedQuantity' : 'InvoicedQuantity');
      return {
        id: val(l, 'ID'), note: val(l, 'Note'),
        qty: q ? Number(q.textContent) : null, unit: q?.getAttribute('unitCode') || '',
        amount: numv(l, 'LineExtensionAmount'),
        name: val(l, 'Item', 'Name'), description: val(l, 'Item', 'Description'),
        buyerItemId: val(l, 'Item', 'BuyersItemIdentification', 'ID'), sellerItemId: val(l, 'Item', 'SellersItemIdentification', 'ID'),
        price: numv(l, 'Price', 'PriceAmount'),
        taxCategory: val(l, 'Item', 'ClassifiedTaxCategory', 'ID'), taxPercent: numv(l, 'Item', 'ClassifiedTaxCategory', 'Percent'),
      };
    }),
  };
}

/** Rechenprüfung der gelesenen Daten (nur Summen – die vollständige Prüfung macht der KoSIT-Validator). */
export function checkSums(x) {
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const problems = [];
  const lineSum = r2(x.lines.reduce((s, l) => s + (l.amount || 0), 0));
  if (x.totals.lines != null && lineSum !== r2(x.totals.lines)) problems.push(`Summe der Positionen (${lineSum}) passt nicht zur Nettosumme (${x.totals.lines}).`);
  if (x.totals.gross != null && r2((x.totals.net ?? 0) + (x.taxAmount || 0)) !== r2(x.totals.gross)) problems.push('Netto + USt ergibt nicht den Bruttobetrag.');
  for (const t of x.taxes) {
    if (t.percent != null && t.taxable != null && t.amount != null && r2(t.taxable * t.percent / 100) !== r2(t.amount)) {
      problems.push(`USt ${t.percent} % von ${t.taxable} ergibt nicht ${t.amount}.`);
    }
  }
  if (x.totals.payable != null && x.totals.gross != null && r2(x.totals.gross - (x.totals.prepaid || 0)) !== r2(x.totals.payable)) problems.push('Der Zahlbetrag passt nicht zum Bruttobetrag.');
  return problems;
}

/** Klartext zu den Codes der Norm */
export const CODE_TEXT = {
  type: { 380: 'Rechnung', 381: 'Gutschrift', 384: 'Rechnungskorrektur', 326: 'Teilrechnung', 389: 'Gutschrift (Selbstfakturierung)', 875: 'Teilschlussrechnung', 876: 'Teilrechnung', 877: 'Schlussrechnung' },
  unit: { SET: 'Satz', C62: 'Stück', H87: 'Stück', EA: 'Stück', XPP: 'Stück', KGM: 'kg', MTR: 'm', LTR: 'l', HUR: 'Std.', DAY: 'Tag(e)', LS: 'pauschal', MON: 'Monat(e)' },
  means: { 1: 'nicht festgelegt', 10: 'bar', 30: 'Überweisung', 31: 'Überweisung', 42: 'Zahlung auf Bankkonto', 48: 'Karte', 49: 'Lastschrift', 57: 'Dauerauftrag', 58: 'SEPA-Überweisung', 59: 'SEPA-Lastschrift', 97: 'Verrechnung', ZZZ: 'vereinbart' },
  tax: { S: 'Normalsatz', Z: 'Nullsatz', E: 'steuerbefreit', AE: 'Steuerschuldnerschaft des Leistungsempfängers', K: 'innergemeinschaftliche Lieferung', G: 'Ausfuhr', O: 'nicht steuerbar' },
  scheme: { EM: 'E-Mail', '0204': 'Leitweg-ID', 9930: 'USt-IdNr.' },
};
