/**
 * Password hashing with scrypt from Node itself: no native build, no extra dependency.
 * Stored as "scrypt$<N>$<salt>$<hash>", so the cost can be raised later without a migration.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COST = 2 ** 15;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, length: number, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { N: cost, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, cost = COST): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, KEY_LENGTH, cost);
  return `scrypt$${cost}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, costText, saltText, hashText] = stored.split('$');
  if (kind !== 'scrypt' || !costText || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await derive(
    password,
    Buffer.from(saltText, 'base64url'),
    expected.length,
    Number(costText),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
