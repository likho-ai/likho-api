/**
 * Mail: invitations and password resets. Sent through SMTP_URL when it is set; without it nothing
 * goes out and the caller says so (an admin then passes the link on by hand). SMTP_URL=memory:
 * keeps the mails in `outbox` instead, for tests.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { CONFIG, type Config } from '../config/config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class MailService {
  private readonly log = new Logger('mail');
  private readonly memory: boolean;
  private readonly transport: Transporter | null;
  /** The mails "sent" with SMTP_URL=memory:. */
  readonly outbox: Mail[] = [];

  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.memory = config.SMTP_URL === 'memory:';
    this.transport = config.SMTP_URL && !this.memory ? nodemailer.createTransport(config.SMTP_URL) : null;
    if (this.transport) this.log.log(`mail goes out through ${new URL(config.SMTP_URL).host}`);
    else if (!this.memory)
      this.log.log('mail is not set up (SMTP_URL); invitation links are handed to admins');
  }

  /** Whether a mail can go out at all. */
  get configured(): boolean {
    return this.memory || this.transport !== null;
  }

  /** Sends one mail. Returns whether it went out; a failure is logged, never thrown. */
  async send(mail: Mail): Promise<boolean> {
    if (this.memory) {
      this.outbox.push(mail);
      return true;
    }
    if (!this.transport) return false;
    try {
      await this.transport.sendMail({ from: this.config.MAIL_FROM, ...mail });
      return true;
    } catch (error) {
      this.log.error(`could not send "${mail.subject}" to ${mail.to}: ${(error as Error).message}`);
      return false;
    }
  }
}
