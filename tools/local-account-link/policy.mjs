export const HOST = 'https://icp-api.io';
export const IDENTITY = '6klfq-niaaa-aaaar-qadbq-cai';
export const USER_INDEX = '4bkt6-4aaaa-aaaaf-aaaiq-cai';
export const TTL_NS = 300_000_000_000n;
export const RP_ID = 'localhost';
const methods = new Map([
  ['verify_account_linking_code', ['update', IDENTITY]],
  ['finalise_account_linking_with_code', ['update', IDENTITY]],
  ['prepare_delegation', ['update', IDENTITY]],
  ['get_delegation', ['query', IDENTITY]],
  ['check_auth_principal_v2', ['query', IDENTITY]],
  ['current_user', ['query', USER_INDEX]],
]);
export function assertRpc(mode, canister, method) {
  const allowed = methods.get(method);
  if (!allowed || allowed[0] !== mode || allowed[1] !== canister) throw new Error('RPC not allowed');
}
export function assertLocalOrigin(location) {
  if (location.hostname !== RP_ID || location.protocol !== 'http:' ||
      !/^\d{1,5}$/.test(location.port) || location.search || location.hash) {
    throw new Error('Open this test on its exact http://localhost port, without URL parameters.');
  }
}
export function principalBytes(value) {
  if (value instanceof Uint8Array && value.length > 0 && value.length <= 29) return value;
  if (Array.isArray(value) && value.length > 0 && value.length <= 29 &&
      value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return Uint8Array.from(value);
  throw new Error('Invalid principal bytes');
}
export function bytes(value, maximum = 65536) {
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) throw new Error('Missing binary field');
  if (!value.length || value.length > maximum || !Array.from(value).every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error('Invalid binary field');
  }
  return Uint8Array.from(value);
}
// Same bounded COSE-item extraction principle as OpenChat's webAuthn.ts. Do not
// include optional authenticator extensions in the registered public key.
export function authDataToCose(value) {
  const data = new Uint8Array(value);
  if (data.length < 56 || data.length > 65536 || !(data[32] & 64)) throw new Error('Invalid authenticator data');
  const idLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(53);
  const start = 55 + idLength;
  if (start >= data.length || (data[start] >> 5) !== 5) throw new Error('Missing COSE key');
  const end = itemEnd(data, start, 0);
  return data.slice(start, end);
}
function itemEnd(data, offset, depth) {
  if (depth > 16 || offset >= data.length) throw new Error('Malformed CBOR');
  const initial = data[offset++], major = initial >> 5, info = initial & 31;
  let argument = info;
  if (info >= 24) {
    if (info > 27) throw new Error('Indefinite CBOR rejected');
    const count = 2 ** (info - 24);
    if (offset + count > data.length) throw new Error('Truncated CBOR');
    argument = 0;
    for (let i = 0; i < count; i++) argument = argument * 256 + data[offset++];
    if (!Number.isSafeInteger(argument)) throw new Error('Oversized CBOR argument');
  }
  if (major === 2 || major === 3) offset += argument;
  if (major === 4 || major === 5) {
    const count = argument * (major === 5 ? 2 : 1);
    if (count > data.length) throw new Error('Oversized CBOR container');
    for (let i = 0; i < count; i++) offset = itemEnd(data, offset, depth + 1);
  }
  if (major === 6) offset = itemEnd(data, offset, depth + 1);
  if (offset > data.length) throw new Error('Truncated CBOR');
  return offset;
}
