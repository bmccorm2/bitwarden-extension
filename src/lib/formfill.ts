// Card and identity form filling (popup "Fill" button). Field detection by autocomplete token, then name/id/label hints.

import { isVisible, setValue } from './fill';
import type { CardView, IdentityView } from './types';

export type FormKind = 'card' | 'identity';
type El = HTMLInputElement | HTMLSelectElement;

interface Rule {
  key: string;
  ac?: string[];
  re?: RegExp;
}

// Order matters: first matching rule wins.
const CARD_RULES: Rule[] = [
  { key: 'code', ac: ['cc-csc'], re: /cvc|cvv|csc|cvn|security.?code|card.?code|verification/ },
  { key: 'name', ac: ['cc-name'], re: /card.?holder|name.?on.?card|cc.?name|card.?name|holder.?name/ },
  { key: 'brand', ac: ['cc-type'], re: /card.?type|card.?brand|cc.?type/ },
  { key: 'expMonth', ac: ['cc-exp-month'], re: /exp.*mon|mon.*exp|cc.?mon|cc.?mm|card.?mon|^mm$/ },
  { key: 'expYear', ac: ['cc-exp-year'], re: /exp.*y(ea)?r|y(ea)?r.*exp|cc.?y(ea)?r|cc.?yy|card.?y(ea)?r|^yy(yy)?$/ },
  { key: 'exp', ac: ['cc-exp'], re: /exp|mm\s*\/\s*yy/ },
  { key: 'number', ac: ['cc-number'], re: /card.?num|cc.?num|card.?no\b|credit.?card|cardnumber|\bpan\b/ },
];

const IDENTITY_RULES: Rule[] = [
  { key: 'title', ac: ['honorific-prefix'], re: /salutation|honorific/ },
  { key: 'firstName', ac: ['given-name'], re: /first.?name|given.?name|fname|forename/ },
  { key: 'middleName', ac: ['additional-name'], re: /middle.?(name|initial)|mname/ },
  { key: 'lastName', ac: ['family-name'], re: /last.?name|family.?name|surname|lname/ },
  { key: 'fullName', ac: ['name'], re: /full.?name|^name$|your.?name/ },
  { key: 'email', ac: ['email'], re: /e.?mail/ },
  { key: 'phone', ac: ['tel', 'tel-national'], re: /phone|mobile|\btel\b|telephone/ },
  { key: 'address2', ac: ['address-line2'], re: /addr(ess)?.?(line)?.?2|apartment|\bapt\b|suite/ },
  { key: 'address3', ac: ['address-line3'], re: /addr(ess)?.?(line)?.?3/ },
  { key: 'address1', ac: ['address-line1', 'street-address'], re: /addr(ess)?.?(line)?.?1|street|^addr(ess)?$/ },
  { key: 'city', ac: ['address-level2'], re: /city|town|locality|suburb/ },
  { key: 'country', ac: ['country', 'country-name'], re: /country/ },
  { key: 'state', ac: ['address-level1'], re: /\bstate\b|province|region|county/ },
  { key: 'postalCode', ac: ['postal-code'], re: /zip|postal|post.?code/ },
  { key: 'company', ac: ['organization'], re: /company|organi[sz]ation|business.?name|employer/ },
  { key: 'username', ac: ['username'], re: /user.?name/ },
  { key: 'ssn', re: /\bssn\b|social.?security/ },
  { key: 'passportNumber', re: /passport/ },
  { key: 'licenseNumber', re: /licen[cs]e|driver/ },
];

const KNOWN_AC =
  /^(cc-|address-|street-address|postal-code|country|given-name|family-name|additional-name|honorific|name$|nickname|email|tel|organization|username|current-password|new-password|one-time-code|bday|sex|url|photo)/;

const INPUT_TYPES = new Set(['text', 'email', 'tel', 'number', 'search', 'password', '']);

function candidates(root: ParentNode, kind: FormKind): El[] {
  return [...root.querySelectorAll<El>('input, select')].filter((el) => {
    if (el.disabled || !isVisible(el)) return false;
    if (el instanceof HTMLSelectElement) return true;
    if (el.readOnly) return false;
    const t = (el.getAttribute('type') ?? '').toLowerCase();
    // Identity forms never get a password field; card forms sometimes mask the number or CVC.
    return INPUT_TYPES.has(t) && (kind === 'card' || t !== 'password');
  });
}

function hints(el: El): string[] {
  const label = el.labels?.[0]?.textContent ?? '';
  const ph = el instanceof HTMLInputElement ? el.placeholder : '';
  return [el.name, el.id, label, el.getAttribute('aria-label') ?? '', ph].map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function classify(el: El, kind: FormKind): string | null {
  const rules = kind === 'card' ? CARD_RULES : IDENTITY_RULES;
  const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  for (const r of rules) if (r.ac?.some((a) => tokens.includes(a))) return r.key;
  // A specific token for something else (e.g. "current-password", "bday"): trust it over name hints.
  if (tokens.some((t) => KNOWN_AC.test(t))) return null;
  const h = hints(el);
  for (const r of rules) if (r.re && h.some((s) => r.re!.test(s))) return r.key;
  // Bare type hints for identity.
  if (kind === 'identity' && el instanceof HTMLInputElement) {
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'phone';
  }
  return null;
}

/** Count of fields this frame would fill. */
export function countFormFields(doc: Document, kind: FormKind): number {
  return candidates(doc, kind).filter((el) => classify(el, kind)).length;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Select the first option whose value or text matches; returns true if one did. */
function pick(sel: HTMLSelectElement, test: (s: string) => boolean): boolean {
  const opt = [...sel.options].find((o) => test(o.value.trim().toLowerCase()) || test(o.text.trim().toLowerCase()));
  if (!opt) return false;
  sel.focus();
  sel.value = opt.value;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function fillCardField(el: El, key: string, c: CardView): boolean {
  const m = parseInt(c.expMonth, 10);
  const mm = m >= 1 && m <= 12 ? String(m).padStart(2, '0') : '';
  const y = c.expYear.trim();
  const yyyy = /^\d{2}$/.test(y) ? `20${y}` : y;
  const yy = yyyy.slice(-2);
  const ph = el instanceof HTMLInputElement ? `${el.placeholder} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase() : '';
  const max = el instanceof HTMLInputElement ? el.maxLength : -1;

  if (el instanceof HTMLSelectElement) {
    switch (key) {
      case 'expMonth':
        return !!mm && pick(el, (s) => new RegExp(`^0?${m}\\b`).test(s) || s.startsWith(MONTHS[m - 1]!.slice(0, 3)));
      case 'expYear':
        return !!y && pick(el, (s) => s === yyyy || s === yy);
      case 'brand':
        return !!c.brand && pick(el, (s) => s === c.brand.toLowerCase() || s.startsWith(c.brand.toLowerCase().slice(0, 4)));
      case 'name':
        return !!c.cardholderName && pick(el, (s) => s === c.cardholderName.toLowerCase());
      default:
        return false;
    }
  }
  let v = '';
  switch (key) {
    case 'number':
      v = c.number.replace(/[\s-]/g, '');
      break;
    case 'code':
      v = c.code;
      break;
    case 'name':
      v = c.cardholderName;
      break;
    case 'brand':
      v = c.brand;
      break;
    case 'expMonth':
      v = mm;
      break;
    case 'expYear':
      v = max === 2 || (/\byy\b/.test(ph) && !/yyyy/.test(ph)) ? yy : yyyy;
      break;
    case 'exp':
      if (mm && y) v = /yyyy/.test(ph) || max >= 7 ? `${mm}/${yyyy}` : `${mm}/${yy}`;
      break;
  }
  if (!v) return false;
  setValue(el, v);
  return true;
}

function fillIdentityField(el: El, key: string, id: IdentityView): boolean {
  const v =
    key === 'fullName'
      ? [id.firstName, id.middleName, id.lastName].filter(Boolean).join(' ')
      : (id as Record<string, string>)[key] ?? '';
  if (!v) return false;
  if (el instanceof HTMLSelectElement) {
    const w = v.toLowerCase();
    return pick(el, (s) => s === w || s.replace(/\.$/, '') === w.replace(/\.$/, ''));
  }
  setValue(el, v);
  return true;
}

/** Fill every recognised field in the document; returns how many were filled. */
export function fillForm(doc: Document, kind: FormKind, data: CardView | IdentityView): number {
  let n = 0;
  for (const el of candidates(doc, kind)) {
    const key = classify(el, kind);
    if (!key) continue;
    const ok = kind === 'card' ? fillCardField(el, key, data as CardView) : fillIdentityField(el, key, data as IdentityView);
    if (ok) n++;
  }
  return n;
}
