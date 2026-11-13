import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countFormFields, fillForm } from '../src/lib/formfill';
import type { CardView, IdentityView } from '../src/lib/types';

beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});
beforeEach(() => {
  document.body.innerHTML = '';
});

const html = (s: string) => (document.body.innerHTML = s);
const v = (sel: string) => (document.querySelector(sel) as HTMLInputElement).value;

const card: CardView = { cardholderName: 'Alice Smith', brand: 'Visa', number: '4111 1111 1111 1111', expMonth: '3', expYear: '2029', code: '123' };
const id: IdentityView = {
  title: 'Ms', firstName: 'Alice', middleName: 'B', lastName: 'Smith', address1: '1 Main St', address2: 'Apt 2', address3: '',
  city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US', company: 'Acme', email: 'a@example.com',
  phone: '555-0100', ssn: '', username: '', passportNumber: '', licenseNumber: '',
};

describe('card', () => {
  it('autocomplete tokens, selects, combined expiry', () => {
    html(`<form>
      <input autocomplete="cc-name" id="n">
      <input autocomplete="cc-number" id="num">
      <select autocomplete="cc-exp-month" id="m"><option value="">--</option><option value="03">03 - Mar</option></select>
      <select id="expYear"><option>2028</option><option>2029</option></select>
      <input autocomplete="cc-csc" id="cvc">
      <input autocomplete="email" id="email"></form>`);
    expect(countFormFields(document, 'card')).toBe(5);
    expect(fillForm(document, 'card', card)).toBe(5);
    expect(v('#n')).toBe('Alice Smith');
    expect(v('#num')).toBe('4111111111111111');
    expect(v('#m')).toBe('03');
    expect(v('#expYear')).toBe('2029');
    expect(v('#cvc')).toBe('123');
    expect(v('#email')).toBe('');
  });

  it('name hints and MM/YY', () => {
    html(`<input name="cardnumber"><input name="exp-date" placeholder="MM / YY"><input name="cvv"><input name="expYear" maxlength="2">`);
    fillForm(document, 'card', card);
    expect(v('[name=cardnumber]')).toBe('4111111111111111');
    expect(v('[name=exp-date]')).toBe('03/29');
    expect(v('[name=cvv]')).toBe('123');
    expect(v('[name=expYear]')).toBe('29');
  });
});

describe('identity', () => {
  it('address form', () => {
    html(`<form>
      <label for="fn">First name</label><input id="fn">
      <input name="lastName">
      <input autocomplete="shipping address-line1" id="a1">
      <input name="address2">
      <input name="city">
      <select name="state"><option value="CA">California</option><option value="IL">Illinois</option></select>
      <input name="zip">
      <select autocomplete="country"><option value="CA">Canada</option><option value="US">United States</option></select>
      <input type="email" id="e">
      <input type="tel" id="t">
      <input type="password" name="password"></form>`);
    expect(fillForm(document, 'identity', id)).toBe(10);
    expect(v('#fn')).toBe('Alice');
    expect(v('[name=lastName]')).toBe('Smith');
    expect(v('#a1')).toBe('1 Main St');
    expect(v('[name=address2]')).toBe('Apt 2');
    expect(v('[name=state]')).toBe('IL');
    expect(v('[name=zip]')).toBe('62701');
    expect(v('select[autocomplete=country]')).toBe('US');
    expect(v('#e')).toBe('a@example.com');
    expect(v('#t')).toBe('555-0100');
    expect(v('[name=password]')).toBe('');
  });

  it('full name field', () => {
    html(`<input autocomplete="name" id="x">`);
    fillForm(document, 'identity', id);
    expect(v('#x')).toBe('Alice B Smith');
  });
});
