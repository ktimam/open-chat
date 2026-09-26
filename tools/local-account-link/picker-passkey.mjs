import { Cbor } from '@icp-sdk/core/agent';
import { WebAuthnIdentity } from '@icp-sdk/core/identity';
import { bytes, RP_ID, assertLocalOrigin } from './policy.mjs';

const equal = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);
const base64url = value => btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const responseBytes = (value, maximum = 65536) => bytes(new Uint8Array(value),maximum);

// SDK 5.4.0 fixes allowCredentials in sign(). Discovery lets the provider show
// its picker instead, but must not change the IC challenge or accept another key.
// IC signature verification and all existing-account checks remain mandatory.
export class PickerWebAuthnIdentity extends WebAuthnIdentity {
  #expectedId;
  #signal;
  constructor(credentialId, cose, signal) {
    super(bytes(credentialId,4096),bytes(cose),undefined);
    this.#expectedId = bytes(credentialId,4096);
    this.#signal = signal;
  }
  async sign(blob) {
    assertLocalOrigin(globalThis.location);
    const origin = globalThis.location.origin;
    const challenge = bytes(blob,4096);
    const result = await navigator.credentials.get({signal:this.#signal,publicKey:{
      rpId:RP_ID,challenge,userVerification:'preferred',timeout:60000,
    }});
    if (this.#signal?.aborted) throw new DOMException('Sign-in cancelled','AbortError');
    if (!result || result.type !== 'public-key' ||
        !equal(responseBytes(result.rawId,4096),this.#expectedId)) throw new Error('Unexpected passkey');
    const response = result.response;
    const clientDataJson = new TextDecoder('utf-8',{fatal:true}).decode(responseBytes(response.clientDataJSON));
    const clientData = JSON.parse(clientDataJson);
    const authData = responseBytes(response.authenticatorData);
    const signature = responseBytes(response.signature,1024);
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(RP_ID)));
    if (clientData.type !== 'webauthn.get' || clientData.origin !== origin ||
        clientData.challenge !== base64url(challenge) || clientData.crossOrigin === true ||
        authData.length < 37 || !(authData[32]&1) || !equal(authData.slice(0,32),rpHash)) {
      throw new Error('Invalid passkey assertion');
    }
    if (this.#signal?.aborted) throw new DOMException('Sign-in cancelled','AbortError');
    // Exact SDK wire shape; no rewriting the signed clientDataJSON or auth data.
    return Cbor.encode({authenticator_data:authData,client_data_json:clientDataJson,signature});
  }
}
