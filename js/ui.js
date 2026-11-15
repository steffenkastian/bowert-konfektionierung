// Kleine UI-Helfer: DOM, Escaping, Sortierung, Icons, Hinweise, Vorschlagslisten.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Für Vergleiche: getrimmt, klein geschrieben. */
export const norm = (v) => String(v ?? '').trim().toLocaleLowerCase('de');
/** Nur Buchstaben und Ziffern – damit findet „202878“ auch „630-202878X“. */
export const compact = (v) => norm(v).replace(/[^\p{L}\p{N}]/gu, '');

/** Natürliche Sortierung: „R2“ vor „R10“. */
export const natCmp = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), 'de', { numeric: true, sensitivity: 'base' });

/** Lagerorte sortieren, leere ans Ende. */
export const locCmp = (a, b) => (!a && !b ? 0 : !a ? 1 : !b ? -1 : natCmp(a, b));

/**
 * Liefert eine Bewertungsfunktion für einen Suchbegriff:
 * 3 = exakt, 2 = beginnt mit, 1 = enthält, 0 = kein Treffer.
 */
export function matcher(query) {
  const n = norm(query);
  const c = compact(query);
  return (value) => {
    if (!n || !value) return 0;
    const nv = norm(value);
    const cv = compact(value);
    if (nv === n || (c && cv === c)) return 3;
    if (nv.startsWith(n) || (c && cv.startsWith(c))) return 2;
    if (nv.includes(n) || (c && cv.includes(c))) return 1;
    return 0;
  };
}

/** „2“ → „2×“, freie Angaben wie „1 je 10 Stk“ bleiben wie sie sind. */
export const qtyLabel = (q) => (!q ? '' : /^\d+([.,]\d+)?$/.test(q) ? `${q}×` : q);

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

let toastTimer = 0;
export function toast(message, kind = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : 2200);
}

// ---------- Icons (inline SVG, Strich-Stil) ----------

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
export const icon = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>'),
  orders: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 11h6M9 15h6"/>'),
  article: svg('<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>'),
  material: svg('<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>'),
  more: svg('<circle cx="5" cy="12" r="1.7" class="fill"/><circle cx="12" cy="12" r="1.7" class="fill"/><circle cx="19" cy="12" r="1.7" class="fill"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  back: svg('<path d="m15 5-7 7 7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: svg('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  logout: svg('<path d="M10 17l5-5-5-5M15 12H3M13 4h6v16h-6"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  phone: svg('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
};

// ---------- Vorschlagsliste unter Eingabefeldern ----------
// Zuverlässiger und besser lesbar als <datalist> auf iOS/Android.

/**
 * @param {HTMLInputElement} input  muss in einem `.suggest-wrap` liegen
 * @param {{source: (q: string) => Array<{label: string, sub?: string}>, onPick: (item: any) => void, max?: number}} opts
 */
export function attachSuggest(input, { source, onPick, max = 8 }) {
  const wrap = input.closest('.suggest-wrap');
  const list = document.createElement('div');
  list.className = 'suggest';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  wrap.append(list);

  let items = [];
  const close = () => { list.hidden = true; };
  const update = () => {
    items = document.activeElement === input ? source(input.value).slice(0, max) : [];
    if (!items.length) return close();
    list.innerHTML = items.map((it, i) => `
      <button type="button" class="suggest-item" role="option" data-i="${i}">
        <span class="suggest-label">${esc(it.label)}</span>
        ${it.sub ? `<span class="suggest-sub">${esc(it.sub)}</span>` : ''}
      </button>`).join('');
    list.hidden = false;
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // Fokus im Eingabefeld halten, damit der Tipp auf einen Vorschlag ankommt.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.suggest-item');
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    close();
    onPick(item);
  });
  return { close, refresh: update };
}
