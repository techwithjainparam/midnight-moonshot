// PRIESTATE — Mail transport abstraction.
//
// `Mailer` is the minimal capability the email contact provider needs.
// The production implementation (`SmtpMailer`) sends REAL email through
// authenticated SMTP via nodemailer; credentials come exclusively from
// server-side environment variables. Tests inject a capture mailer —
// no network, no secrets.

export interface Mailer {
  /** Deliver a message. Resolves on acceptance by the transport. */
  send(input: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export function otpEmailText(code: string, ttlMinutes: number): string {
  return [
    'PRIESTATE — Email verification',
    '',
    `Your verification code is: ${code}`,
    '',
    `This code expires in ${ttlMinutes} minutes and can be used once.`,
    'If you did not request it, ignore this message — do not share the code with anyone.',
  ].join('\n');
}

export function otpEmailHtml(code: string, ttlMinutes: number): string {
  const esc = code.replace(/</g, '&lt;');
  return [
    '<div style="font-family:sans-serif;max-width:480px">',
    '<h2 style="margin-bottom:4px">PRIESTATE — Email verification</h2>',
    `<p>Use this code to verify your email address. It expires in ${ttlMinutes} minutes.</p>`,
    `<p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0">${esc}</p>`,
    '<p style="color:#666;font-size:13px">This code can be used once. If you did not request it, ignore this message. Never share the code with anyone.</p>',
    '</div>',
  ].join('<br/>');
}
