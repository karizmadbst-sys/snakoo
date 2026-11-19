const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function randomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex || randomHex(16);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return {
    hash: `pbkdf2:${toHex(new Uint8Array(bits))}`,
    salt,
  };
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  saltHex: string
): Promise<boolean> {
  const cleanStored = storedHash.startsWith('pbkdf2:') ? storedHash.slice(7) : storedHash;
  const derived = await hashPassword(password, saltHex);
  const cleanDerived = derived.hash.slice(7);

  const a = fromHex(cleanDerived);
  const b = fromHex(cleanStored);
  if (a.length !== b.length || a.length === 0) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
