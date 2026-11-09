// API shapes (after key normalization) and decrypted view models.

export const CipherType = { Login: 1, SecureNote: 2, Card: 3, Identity: 4, SshKey: 5 } as const;

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  key?: string;
  [k: string]: unknown;
}

export interface PreloginResponse {
  kdf: number;
  kdfIterations: number;
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
}

/** Raw encrypted cipher as returned by the server. Unknown fields must be preserved. */
export interface RawCipher {
  id: string;
  type: number;
  folderId: string | null;
  organizationId?: string | null;
  name: string | null;
  notes: string | null;
  favorite: boolean;
  reprompt: number;
  key: string | null;
  login?: RawLogin | null;
  card?: Record<string, unknown> | null;
  identity?: Record<string, unknown> | null;
  secureNote?: { type: number } | null;
  fields?: RawField[] | null;
  passwordHistory?: { password: string; lastUsedDate: string }[] | null;
  attachments?: unknown[] | null;
  revisionDate: string;
  creationDate?: string;
  deletedDate?: string | null;
  [k: string]: unknown;
}

export interface RawLogin {
  username: string | null;
  password: string | null;
  totp: string | null;
  passwordRevisionDate?: string | null;
  uris?: { uri: string | null; match: number | null; uriChecksum?: string | null; [k: string]: unknown }[] | null;
  fido2Credentials?: { creationDate?: string; [k: string]: unknown }[] | null;
  [k: string]: unknown;
}

export interface RawField {
  name: string | null;
  value: string | null;
  type: number;
  linkedId?: number | null;
  [k: string]: unknown;
}

export interface RawFolder {
  id: string;
  name: string;
  revisionDate?: string;
}

export interface SyncResponse {
  profile: { id: string; email: string; key: string; [k: string]: unknown };
  folders: RawFolder[];
  ciphers: RawCipher[];
  [k: string]: unknown;
}

// ---- Decrypted models ----

export interface UriView {
  uri: string;
  match: number | null;
}

export interface FieldView {
  name: string;
  value: string;
  type: number;
  linkedId: number | null;
}

export interface LoginView {
  username: string;
  password: string;
  totp: string;
  uris: UriView[];
  passwordRevisionDate: string | null;
  /** Read-only: creation dates of attached passkeys. */
  passkeys: string[];
}

export const CARD_FIELDS = ['cardholderName', 'brand', 'number', 'expMonth', 'expYear', 'code'] as const;
export const IDENTITY_FIELDS = [
  'title',
  'firstName',
  'middleName',
  'lastName',
  'address1',
  'address2',
  'address3',
  'city',
  'state',
  'postalCode',
  'country',
  'company',
  'email',
  'phone',
  'ssn',
  'username',
  'passportNumber',
  'licenseNumber',
] as const;

export type CardView = Record<(typeof CARD_FIELDS)[number], string>;
export type IdentityView = Record<(typeof IDENTITY_FIELDS)[number], string>;

/** Fully decrypted item. Empty strings stand for null. */
export interface CipherView {
  id: string | null;
  type: number;
  name: string;
  notes: string;
  folderId: string | null;
  favorite: boolean;
  reprompt: number;
  login: LoginView | null;
  card: CardView | null;
  identity: IdentityView | null;
  fields: FieldView[];
  passwordHistory: { password: string; lastUsedDate: string }[];
  revisionDate: string | null;
  creationDate: string | null;
  deletedDate: string | null;
  hasPerItemKey: boolean;
}

/** Row in the list (cheap fields only). */
export interface ListRow {
  id: string;
  type: number;
  name: string;
  username: string;
  uri: string;
  uris: UriView[];
  folderId: string | null;
  favorite: boolean;
  deleted: boolean;
  hasTotp: boolean;
  /** Card brand / identity name, shown as subtitle. */
  subtitle: string;
}

export interface FolderView {
  id: string;
  name: string;
}
