// PRIESTATE — Test helper: re-export of provider result types so capture
// providers in tests can be typed precisely (fail-closed honest boundaries).
import type { SmsSendResult } from '../../server/account/sms-provider';
import type { WhatsAppSendResult } from '../../server/account/whatsapp-provider';

export type { SmsSendResult, WhatsAppSendResult };