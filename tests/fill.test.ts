import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureFrom,
  detectMode,
  fillLogin,
  fillTotp,
  passwordFields,
  setValue,
  splitOtpFields,
  totpField,
  usernameOnlyField,
} from '../src/lib/fill';

// happy-dom has no layout: give every element a size unless it (or an ancestor) is display:none.
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});

beforeEach(() => {
  document.body.innerHTML = '';
});

const html = (s: string) => (document.body.innerHTML = s);
const $ = (sel: string) => document.querySelector(sel) as HTMLInputElement;
const creds = { username: 'alice@example.com', password: 's3cret', fields: [] };

describe('login forms', () => {
  it('standard form', () => {
    html(`<form>
      <input type="text" name="search" style="display:none">
      <input type="email" id="email">
      <input type="password" id="pw">
      <button type="submit">Sign in</button></form>`);
    expect(detectMode(document)).toBe('login');
    expect(fillLogin(document, creds)).toBe(true);
    expect($('#email').value).toBe('alice@example.com');
    expect($('#pw').value).toBe('s3cret');
  });

  it('ignores hidden fields', () => {
    html(`<form>
      <input type="text" id="user">
      <input type="text" id="hiddenUser" style="display:none">
      <div style="display:none"><input type="password" id="pwHidden"></div>
      <input type="password" id="pwInvisible" style="visibility:hidden">
      <input type="hidden" name="csrf" value="x">
      <input type="password" id="pw">
    </form>`);
    expect(passwordFields(document).map((e) => e.id)).toEqual(['pw']);
    fillLogin(document, creds);
    expect($('#pw').value).toBe('s3cret');
    expect($('#pwHidden').value).toBe('');
    expect($('#pwInvisible').value).toBe('');
    expect($('#user').value).toBe('alice@example.com');
    expect($('#hiddenUser').value).toBe('');
  });

  it('username-first page', () => {
    html(`<input type="search" id="q"><input type="text" name="login_name" id="u"><button>Next</button>`);
    expect(detectMode(document)).toBe('login');
    expect(usernameOnlyField(document)?.id).toBe('u');
    fillLogin(document, creds);
    expect($('#u').value).toBe('alice@example.com');
    expect($('#q').value).toBe('');
  });

  it('prefers autocomplete=username', () => {
    html(`<input type="text" id="a" name="email2"><input type="text" id="b" autocomplete="username">`);
    expect(usernameOnlyField(document)?.id).toBe('b');
  });

  it('React-style controlled input sees the change', () => {
    html(`<input type="text" id="u"><input type="password" id="pw">`);
    const el = $('#u');
    // Emulate React's value tracker: an own-property setter that records the "last known" value.
    let tracked = '';
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() {
        return proto.get!.call(this);
      },
      set(v: string) {
        tracked = v;
        proto.set!.call(this, v);
      },
    });
    const seen: string[] = [];
    document.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.value !== tracked) seen.push(t.value); // React fires onChange only when value != tracker
    });
    let changed = 0;
    document.addEventListener('change', () => changed++);
    setValue(el, 'bob');
    expect(seen).toEqual(['bob']);
    expect(changed).toBe(1);
    expect(document.activeElement).toBe(el);
  });

  it('fills custom fields by name or id', () => {
    html(`<input type="text" name="Company"><input type="text" id="pin"><input type="password">`);
    fillLogin(document, { ...creds, fields: [{ name: 'company', value: 'ACME' }, { name: 'PIN', value: '42' }] });
    expect($('[name=Company]').value).toBe('ACME');
    expect($('#pin').value).toBe('42');
  });
});

describe('TOTP', () => {
  it('single OTP input', () => {
    html(`<input type="text" name="otp_code" maxlength="6">`);
    expect(detectMode(document)).toBe('totp');
    expect(fillTotp(document, '123456')).toBe(true);
    expect($('input').value).toBe('123456');
  });

  it('autocomplete one-time-code', () => {
    html(`<input type="text" id="x" autocomplete="one-time-code">`);
    expect(totpField(document)?.id).toBe('x');
  });

  it('numeric inputmode', () => {
    html(`<input type="text" id="verification-code" inputmode="numeric">`);
    expect(totpField(document)?.id).toBe('verification-code');
  });

  it('not a TOTP field without length/inputmode hint', () => {
    html(`<input type="text" name="promo_code">`);
    expect(totpField(document)).toBeNull();
  });

  it('6-box OTP', () => {
    html(`<div>${Array.from({ length: 6 }, (_, i) => `<input type="text" maxlength="1" id="d${i}">`).join('')}</div>`);
    expect(detectMode(document)).toBe('totp');
    expect(splitOtpFields(document)).toHaveLength(6);
    fillTotp(document, '987654');
    expect([...document.querySelectorAll('input')].map((i) => i.value).join('')).toBe('987654');
  });

  it('password page wins over OTP detection', () => {
    html(`<input type="password"><input name="otp" maxlength="6">`);
    expect(detectMode(document)).toBe('login');
  });
});

describe('capture', () => {
  it('login form', () => {
    html(`<form><input type="email" value="a@b.c"><input type="password" value="pw1"></form>`);
    expect(captureFrom(document.querySelector('form')!)).toEqual({ username: 'a@b.c', password: 'pw1', change: false });
  });

  it('password-change form captures the new password', () => {
    html(`<form><input type="text" value="bob">
      <input type="password" autocomplete="current-password" value="old">
      <input type="password" autocomplete="new-password" value="new">
      <input type="password" autocomplete="new-password" value="new"></form>`);
    expect(captureFrom(document.querySelector('form')!)).toEqual({ username: 'bob', password: 'new', change: true });
  });

  it('empty password → nothing', () => {
    html(`<form><input type="text" value="bob"><input type="password"></form>`);
    expect(captureFrom(document.querySelector('form')!)).toBeNull();
  });
});
