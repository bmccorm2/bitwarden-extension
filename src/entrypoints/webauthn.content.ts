// Main-world wrapper for navigator.credentials.get (Decision 20). Runs in the page: no extension APIs,
// and the page can see/forge everything here. All checks happen in the background.

import type { PasskeyAssertion, PkToIsolated, PkToMain } from '@/lib/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',
  // Firefox supports MAIN-world content scripts only from 128; strict_min_version is 121.
  exclude: ['firefox'],
  main() {
    const creds = navigator.credentials;
    if (!creds?.get || typeof PublicKeyCredential === 'undefined') return;
    const original = creds.get.bind(creds);

    const READY_WAIT_MS = 5000;
    const ACK_WAIT_MS = 1000;
    let ready = false;
    const readyWaiters: (() => void)[] = [];
    const pending = new Map<string, (m: PkToMain) => void>();

    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const m = e.data as PkToMain | null;
      if (!m || typeof m !== 'object' || typeof m.lw !== 'string') return;
      if (m.lw === 'pk-ready') {
        ready = true;
        readyWaiters.splice(0).forEach((f) => f());
      } else if ('id' in m && typeof m.id === 'string') pending.get(m.id)?.(m);
    });

    const post = (m: PkToIsolated) => window.postMessage(m, '*');
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    function bytes(x: unknown): Uint8Array {
      if (x instanceof ArrayBuffer) return new Uint8Array(x);
      if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      throw new TypeError('Expected a BufferSource');
    }
    function b64url(u: Uint8Array): string {
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function unb64url(s: string): ArrayBuffer {
      const b = s.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out.buffer;
    }

    function buildCredential(a: PasskeyAssertion): PublicKeyCredential {
      const own = (o: object, props: Record<string, unknown>) => {
        for (const [k, value] of Object.entries(props)) Object.defineProperty(o, k, { value, enumerable: true });
        return o;
      };
      const json = {
        id: a.id,
        rawId: a.id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: a.clientDataJSON,
          authenticatorData: a.authenticatorData,
          signature: a.signature,
          userHandle: a.userHandle ?? undefined,
        },
        clientExtensionResults: {},
      };
      const response = own(Object.create(AuthenticatorAssertionResponse.prototype), {
        clientDataJSON: unb64url(a.clientDataJSON),
        authenticatorData: unb64url(a.authenticatorData),
        signature: unb64url(a.signature),
        userHandle: a.userHandle ? unb64url(a.userHandle) : null,
      });
      return own(Object.create(PublicKeyCredential.prototype), {
        id: a.id,
        rawId: unb64url(a.id),
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response,
        getClientExtensionResults: () => ({}),
        toJSON: () => structuredClone(json),
      }) as PublicKeyCredential;
    }

    async function viaLightwarden(options: CredentialRequestOptions): Promise<Credential | null> {
      const pk = options.publicKey!;
      const signal = options.signal;
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      let req: PkToIsolated & { lw: 'pk-req' };
      try {
        req = {
          lw: 'pk-req',
          id: crypto.randomUUID(),
          rpId: typeof pk.rpId === 'string' ? pk.rpId : null,
          challenge: b64url(bytes(pk.challenge)),
          allow: (pk.allowCredentials ?? []).map((c) => b64url(bytes(c.id))),
          userVerification: String(pk.userVerification ?? 'preferred'),
        };
      } catch {
        return original(options); // malformed options: let the browser produce its own error
      }

      if (!ready) await Promise.race([new Promise<void>((r) => readyWaiters.push(r)), sleep(READY_WAIT_MS)]);
      if (!ready) return original(options);

      const id = req.id;
      return new Promise<Credential | null>((resolve, reject) => {
        let acked = false;
        const done = () => {
          pending.delete(id);
          signal?.removeEventListener('abort', onAbort);
        };
        const fallback = () => {
          done();
          original(options).then(resolve, reject);
        };
        const onAbort = () => {
          done();
          post({ lw: 'pk-abort', id });
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort);
        pending.set(id, (m) => {
          if (m.lw === 'pk-ack') {
            acked = true;
            return;
          }
          if (m.lw !== 'pk-res') return;
          if ('cred' in m) {
            done();
            try {
              resolve(buildCredential(m.cred));
            } catch {
              fallback();
            }
          } else if ('error' in m) {
            done();
            reject(new DOMException('The operation is not allowed.', m.error));
          } else fallback();
        });
        post(req);
        // An orphaned content script (extension reloaded) never acks.
        setTimeout(() => {
          if (!acked && pending.has(id)) fallback();
        }, ACK_WAIT_MS);
      });
    }

    const wrapped = function get(this: CredentialsContainer, options?: CredentialRequestOptions) {
      if (!options?.publicKey || options.mediation === 'conditional') return original(options);
      return viaLightwarden(options).catch((e) => {
        if (e instanceof DOMException) throw e;
        return original(options);
      });
    };
    Object.defineProperty(creds, 'get', { value: wrapped, configurable: true, writable: true });
  },
});
