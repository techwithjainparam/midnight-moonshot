// PRIESTATE — Real SMTP mail delivery (production transport).
//
// Wraps nodemailer with credentials supplied ONLY from server-side env
// vars (see ./config.ts). Nothing in this module is reachable from the
// browser bundle.

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { ServerConfig } from '../config';
import type { Mailer } from './mailer';

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(emailConfig: ServerConfig['email']) {
    this.transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      auth: {
        user: emailConfig.user,
        pass: emailConfig.pass,
      },
    });
    this.from = emailConfig.from;
  }

  async send(input: { to: string; subject: string; text: string; html: string }): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...input });
  }
}

/** Build the production mailer, or null when SMTP is not configured. */
export function createSmtpMailer(config: ServerConfig): SmtpMailer | null {
  if (!config.email.configured) return null;
  return new SmtpMailer(config.email);
}
