import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * Students' passwords are kept readable for the teacher (export, account emails), encrypted with
 * CREDENTIALS_KEY. The key lives only in the server's .env, so a leaked database or backup alone
 * does not reveal them. Logins still check the bcrypt hash; this copy is never used to sign in.
 */
const key = Buffer.from(config.credentialsKey, 'hex');
const VERSION = 'v1';

/** "v1:<iv>:<auth tag>:<ciphertext>", each part base64. */
export function encryptPassword(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** The password, or null when none is stored or it was encrypted with a different key. */
export function decryptPassword(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [version, iv, tag, data] = stored.split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
