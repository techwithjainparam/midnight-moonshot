// PRIESTATE — Test helper: build configured (honest, capture-able) delivery
// providers for AccountService unit tests that only need the factors enabled.
import type { SmsProvider } from '../../server/account/sms-provider';
import type { WhatsAppProvider } from '../../server/account/whatsapp-provider';
import type { GoogleProviderObject } from '../../server/account/google-provider';
import type { SmsSendResult, WhatsAppSendResult } from './provider-types';
import { createGoogleTestKit } from './google-oauth-kit';

export function configuredProviders(): {
  smsProvider: SmsProvider;
  whatsAppProvider: WhatsAppProvider;
  googleProvider: GoogleProviderObject;
} {
  const kit = createGoogleTestKit();
  return {
    smsProvider: {
      name: 'capture',
      configured: true,
      send: async (): Promise<SmsSendResult> => ({ ok: true }),
    },
    whatsAppProvider: {
      name: 'capture',
      configured: true,
      send: async (): Promise<WhatsAppSendResult> => ({ ok: true }),
    },
    googleProvider: kit.provider,
  };
}