import bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';

const ROUNDS = 12;

/** No 0/O, 1/l/I: easy to read off a printout or an email. */
const READABLE = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A random 10-character password for a student. */
export function randomPassword(length = 10): string {
  return Array.from({ length }, () => READABLE[randomInt(READABLE.length)]).join('');
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// Compared against when the user does not exist, so response time doesn't reveal valid SR codes.
export const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', ROUNDS);
