// DOM field detection and value setting for the content script.

export type FillMode = 'login' | 'totp';

const TEXTISH = new Set(['text', 'email', 'tel', '']);
const TOTP_RE = /otp|totp|2fa|mfa|one.?time|verification.?code|auth.?code|security.?code|code/i;
const USER_RE = /user|email|login/i;

export function isVisible(el: HTMLElement): boolean {
  if (el.hidden || (el as HTMLInputElement).type === 'hidden') return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkVisibilityCSS: true } as CheckVisibilityOptions);
  }
  for (let n: Element | null = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.display === 'none') return false;
    if (n === el && (s.visibility === 'hidden' || s.visibility === 'collapse')) return false;
  }
  return true;
}

function usable(el: HTMLInputElement): boolean {
  return !el.disabled && !el.readOnly && isVisible(el);
}

function visibleInputs(root: ParentNode): HTMLInputElement[] {
  return [...root.querySelectorAll('input')].filter(usable);
}

const type = (el: HTMLInputElement) => (el.getAttribute('type') ?? '').toLowerCase();
const ac = (el: HTMLInputElement) => (el.getAttribute('autocomplete') ?? '').toLowerCase();
const ident = (el: HTMLInputElement) => `${el.name} ${el.id}`;

export function passwordFields(doc: Document): HTMLInputElement[] {
  return visibleInputs(doc).filter((el) => type(el) === 'password');
}

function isUsernameLike(el: HTMLInputElement): boolean {
  const a = ac(el);
  return TEXTISH.has(type(el)) || a.includes('username') || a.includes('email');
}

/** Nearest preceding visible username-like input in the same form, else in document order. */
export function usernameFor(pw: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = pw.form ?? pw.ownerDocument;
  const all = visibleInputs(scope);
  const i = all.indexOf(pw);
  for (let j = i - 1; j >= 0; j--) {
    const el = all[j]!;
    if (type(el) !== 'password' && isUsernameLike(el)) return el;
  }
  return null;
}

/** Username-first pages (no password field). */
export function usernameOnlyField(doc: Document): HTMLInputElement | null {
  const all = visibleInputs(doc).filter((el) => TEXTISH.has(type(el)) || ac(el).includes('username') || ac(el).includes('email'));
  return (
    all.find((el) => /\b(username|email)\b/.test(ac(el))) ??
    all.find((el) => type(el) === 'email') ??
    all.find((el) => USER_RE.test(ident(el))) ??
    null
  );
}

/** A single OTP input. */
export function totpField(doc: Document): HTMLInputElement | null {
  const all = visibleInputs(doc).filter((el) => TEXTISH.has(type(el)) || type(el) === 'number' || ac(el) === 'one-time-code');
  return (
    all.find((el) => ac(el) === 'one-time-code' && !(el.maxLength === 1)) ??
    all.find((el) => {
      if (!TOTP_RE.test(`${ident(el)} ${el.placeholder}`)) return false;
      const ml = el.maxLength;
      return (ml >= 6 && ml <= 8) || el.inputMode === 'numeric';
    }) ??
    null
  );
}

/** Six (or more) adjacent single-character inputs. */
export function splitOtpFields(doc: Document): HTMLInputElement[] | null {
  const all = visibleInputs(doc);
  let run: HTMLInputElement[] = [];
  for (const el of all) {
    if (el.maxLength === 1 && (TEXTISH.has(type(el)) || type(el) === 'number')) {
      run.push(el);
      if (run.length === 6) return run;
    } else run = [];
  }
  return null;
}

export function detectMode(doc: Document): FillMode | null {
  if (passwordFields(doc).length) return 'login';
  if (totpField(doc) || splitOtpFields(doc)) return 'totp';
  if (usernameOnlyField(doc)) return 'login';
  return null;
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

/** Set a value so React/Vue controlled inputs notice it. */
export function setValue(el: HTMLInputElement, value: string): void {
  el.focus();
  nativeValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface LoginFill {
  username: string;
  password: string;
  fields: { name: string; value: string }[];
}

/** Returns true if anything was filled. */
export function fillLogin(doc: Document, creds: LoginFill): boolean {
  let filled = false;
  const pw = passwordFields(doc)[0];
  if (pw) {
    const user = usernameFor(pw);
    if (user && creds.username) {
      setValue(user, creds.username);
      filled = true;
    }
    if (creds.password) {
      setValue(pw, creds.password);
      filled = true;
    }
  } else {
    const user = usernameOnlyField(doc);
    if (user && creds.username) {
      setValue(user, creds.username);
      filled = true;
    }
  }
  if (creds.fields.length) {
    const inputs = visibleInputs(doc).filter((el) => TEXTISH.has(type(el)));
    for (const f of creds.fields) {
      const n = f.name.toLowerCase();
      if (!n) continue;
      const el = inputs.find((i) => i.name.toLowerCase() === n || i.id.toLowerCase() === n);
      if (el) {
        setValue(el, f.value);
        filled = true;
      }
    }
  }
  if (pw) pw.focus();
  return filled;
}

export function fillTotp(doc: Document, code: string): boolean {
  const single = totpField(doc);
  if (single) {
    setValue(single, code);
    return true;
  }
  const boxes = splitOtpFields(doc);
  if (!boxes) return false;
  [...code].slice(0, boxes.length).forEach((d, i) => setValue(boxes[i]!, d));
  return true;
}

// ---- capture helpers (M7) ----

export interface Captured {
  username: string;
  password: string;
  /** Password-change form: `password` is the new password. */
  change: boolean;
}

/** Read credentials from a form (or the document, for formless pages) containing a filled password field. */
export function captureFrom(scope: ParentNode): Captured | null {
  const pws = visibleInputs(scope).filter((el) => type(el) === 'password' && el.value);
  if (!pws.length) return null;
  const newPw = pws.find((el) => ac(el).includes('new-password'));
  const other = pws.find((el) => el !== newPw && el.value !== newPw?.value);
  if (newPw && other) {
    // Password-change form: current + new password.
    const user = usernameFor(pws[0]!);
    return { username: user?.value.trim() ?? '', password: newPw.value, change: true };
  }
  const pw = pws[0]!;
  const user = usernameFor(pw);
  return { username: user?.value.trim() ?? '', password: pw.value, change: false };
}
