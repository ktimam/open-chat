import { bytes, RP_ID } from './policy.mjs';

// Persist an explicit public allowlist, never whole SDK identities or responses.
export function publicRecord(value) {
  const text = (v, optional = false) => {
    if (optional && v === undefined) return undefined;
    if (typeof v !== 'string' || !v.trim() || v.length > 100) throw new Error('Invalid public metadata');
    return v.trim();
  };
  const c = value.credential;
  if (!c || c.origin !== RP_ID || typeof c.crossPlatform !== 'boolean') throw new Error('Invalid credential');
  const aaguid = Array.from(bytes(c.aaguid, 16));
  if (aaguid.length !== 16) throw new Error('Invalid authenticator metadata');
  return {
    credential: { credentialId: Array.from(bytes(c.credentialId, 4096)), publicKey: Array.from(bytes(c.publicKey, 4096)),
      origin: RP_ID, crossPlatform: c.crossPlatform, aaguid },
    expectedUsername: text(value.expectedUsername), expectedUserId: text(value.expectedUserId, true),
    expectedOcPrincipal: text(value.expectedOcPrincipal, true),
  };
}
