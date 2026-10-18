import bcrypt from 'bcrypt';

const ROUNDS = 12;

export const hashPassword = (plain: string) => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// Compared against when the user does not exist, so response time doesn't reveal valid SR codes.
export const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', ROUNDS);
