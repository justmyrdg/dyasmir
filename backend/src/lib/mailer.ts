import nodemailer from 'nodemailer';
import { config } from '../config';

const { smtp } = config;

const transport = smtp.host
  ? nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      // Fail within seconds rather than minutes, so a bulk import is not held up by an unreachable server.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    })
  : null;

/** False when SMTP_HOST is empty: emails are turned off. */
export function mailConfigured(): boolean {
  return transport !== null;
}

/** Sends a plain-text email. Throws when email is turned off or the mail server refuses it. */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!transport) throw new Error('Email is not set up on the server (SMTP_HOST in .env).');
  await transport.sendMail({ from: smtp.from, to, subject, text });
}
