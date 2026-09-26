// PRIESTATE — International dialling plan data for the personal-information
// phone field.
//
// WHY THIS EXISTS
// The registration form lets a citizen pick a country code. The SMS and
// WhatsApp gateways are both addressed in E.164, so the *transport* is
// country-agnostic — but the number must still be well-formed for the country
// it claims, or we would store an unroutable address and then blame the
// gateway for "delivering" nothing.
//
// SCOPE, DELIBERATELY NARROW
// This is a validation table, not a claims database. It records the dialling
// code and the national-number shape we accept. It makes NO claim that a
// number is assigned, reachable, or that any particular gateway is enabled for
// that country. A well-formed number here is a formatting fact, exactly like a
// well-formed PAN — never a verification.
//
// IDENTITY REMAINS INDIA-ONLY
// Aadhaar, the India Post pincode lookup and the state list are India-specific
// and are unchanged. A citizen who selects another country is asked for a
// foreign phone number but is still verified against an Indian Aadhaar; the
// form states this plainly rather than implying a foreign registration path
// exists.

/** One country's dialling plan. */
export interface DiallingPlan {
  /** ISO 3166-1 alpha-2. */
  readonly iso2: string;
  /** Display name for the selector. */
  readonly name: string;
  /** E.164 calling code, without the "+". */
  readonly callingCode: string;
  /**
   * Total digits expected AFTER the calling code, as a range. NSN length
   * varies within a country (landline vs mobile, and some countries have
   * variable-length plans), so this is a min/max pair.
   */
  readonly nsnLength: readonly [number, number];
  /**
   * Mobile prefixes, where the country's mobile numbering plan is usefully
   * distinguishable. Empty means "do not constrain the leading digit", which is
   * the honest default when a country's mobile ranges are not reliably known
   * to us — better to accept a well-formed number of the right length than to
   * reject a valid one we mis-enumerated.
   */
  readonly mobilePrefixes: readonly string[];
  /** True when the country's plan allows a trunk "0" prefix to be dropped. */
  readonly allowsTrunkZero: boolean;
}

function plan(
  iso2: string,
  name: string,
  callingCode: string,
  min: number,
  max: number,
  mobilePrefixes: readonly string[] = [],
  allowsTrunkZero = false,
): DiallingPlan {
  return { iso2, name, callingCode, nsnLength: [min, max], mobilePrefixes, allowsTrunkZero };
}

/**
 * Supported dialling plans. Ordered by calling code, then name, so the
 * selector renders deterministically.
 *
 * The India Post pincode lookup and the Aadhaar identity model remain
 * India-only; adding a country here widens which phone numbers the gateways
 * may be asked to deliver to, and nothing else.
 */
export const DIALLING_PLANS: readonly DiallingPlan[] = [
  plan('AE', 'United Arab Emirates', '971', 9, 9, ['50', '52', '54', '55', '56', '58']),
  plan('AR', 'Argentina', '54', 10, 11, ['9']),
  plan('AT', 'Austria', '43', 7, 11),
  plan('AU', 'Australia', '61', 9, 9, ['4'], true),
  plan('BD', 'Bangladesh', '880', 10, 10, ['13', '14', '15', '16', '17', '18', '19']),
  plan('BE', 'Belgium', '32', 8, 9, ['4']),
  plan('BH', 'Bahrain', '973', 8, 8, ['3']),
  plan('BR', 'Brazil', '55', 10, 11, ['9'], true),
  plan('CA', 'Canada', '1', 10, 10, ['2', '3', '4', '5', '6', '7', '8', '9']),
  plan('CH', 'Switzerland', '41', 9, 9, ['7']),
  plan('CL', 'Chile', '56', 9, 9, ['9']),
  plan('CN', 'China', '86', 11, 11, ['13', '14', '15', '16', '17', '18', '19']),
  plan('CO', 'Colombia', '57', 10, 10, ['3']),
  plan('DE', 'Germany', '49', 6, 11, ['15', '16', '17']),
  plan('DK', 'Denmark', '45', 8, 8),
  plan('EG', 'Egypt', '20', 9, 10, ['10', '11', '12', '15']),
  plan('ES', 'Spain', '34', 9, 9, ['6', '7']),
  plan('FI', 'Finland', '358', 9, 10, ['4', '5']),
  plan('FR', 'France', '33', 9, 9, ['6', '7'], true),
  // UK mobiles are 7 followed by a digit that is neither 0 nor 1 (70/71 are
  // reserved), so the prefix is the two leading digits.
  plan('GB', 'United Kingdom', '44', 9, 10, ['72', '73', '74', '75', '76', '77', '78', '79'], true),
  plan('GH', 'Ghana', '233', 9, 9, ['2', '5']),
  plan('GR', 'Greece', '30', 10, 10, ['6']),
  plan('HK', 'Hong Kong', '852', 8, 8, ['5', '6', '9']),
  plan('ID', 'Indonesia', '62', 9, 12, ['8']),
  plan('IE', 'Ireland', '353', 9, 9, ['8'], true),
  plan('IL', 'Israel', '972', 9, 9, ['5']),
  plan('IN', 'India', '91', 10, 10, ['6', '7', '8', '9'], true),
  plan('IT', 'Italy', '39', 9, 11, ['3']),
  plan('JP', 'Japan', '81', 9, 10, ['70', '80', '90'], true),
  plan('KE', 'Kenya', '254', 9, 9, ['1', '7']),
  plan('KR', 'South Korea', '82', 9, 10, ['1'], true),
  plan('LK', 'Sri Lanka', '94', 9, 9, ['7']),
  plan('MA', 'Morocco', '212', 9, 9, ['6', '7']),
  plan('MY', 'Malaysia', '60', 9, 10, ['1']),
  plan('NG', 'Nigeria', '234', 10, 10, ['70', '80', '81', '90', '91']),
  plan('NL', 'Netherlands', '31', 9, 9, ['6']),
  plan('NO', 'Norway', '47', 8, 8, ['4', '9']),
  plan('NP', 'Nepal', '977', 10, 10, ['97', '98']),
  plan('NZ', 'New Zealand', '64', 8, 10, ['2'], true),
  plan('OM', 'Oman', '968', 8, 8, ['7', '9']),
  plan('PE', 'Peru', '51', 9, 9, ['9']),
  plan('PH', 'Philippines', '63', 10, 10, ['9']),
  plan('PK', 'Pakistan', '92', 10, 10, ['3']),
  plan('PL', 'Poland', '48', 9, 9, ['4', '5', '6', '7', '8']),
  plan('PT', 'Portugal', '351', 9, 9, ['9']),
  plan('QA', 'Qatar', '974', 8, 8, ['3', '5', '6', '7']),
  plan('RO', 'Romania', '40', 9, 9, ['7']),
  plan('SA', 'Saudi Arabia', '966', 9, 9, ['5']),
  plan('SE', 'Sweden', '46', 7, 9, ['7'], true),
  plan('SG', 'Singapore', '65', 8, 8, ['8', '9']),
  plan('TH', 'Thailand', '66', 8, 9, ['6', '8', '9']),
  plan('TR', 'Turkey', '90', 10, 10, ['5']),
  plan('TW', 'Taiwan', '886', 8, 9, ['9']),
  plan('US', 'United States', '1', 10, 10, ['2', '3', '4', '5', '6', '7', '8', '9']),
  plan('VN', 'Vietnam', '84', 9, 10, ['3', '5', '7', '8', '9']),
  plan('ZA', 'South Africa', '27', 9, 9, ['6', '7', '8']),
];

/** The plan the form starts on, and the only one the pincode path supports. */
export const DEFAULT_CALLING_CODE = '+91';

export function plansForCallingCode(callingCode: string): DiallingPlan[] {
  const bare = callingCode.replace(/^\+/, '');
  return DIALLING_PLANS.filter((p) => p.callingCode === bare);
}

export function findPlan(callingCode: string): DiallingPlan | null {
  const bare = callingCode.replace(/^\+/, '');
  const candidates = plansForCallingCode(bare);
  if (candidates.length === 0) return null;
  // Shared calling code: prefer a plan whose national number is a fixed length
  // and whose mobile prefixes cover the number, so +1 resolves to the NANP
  // shape rather than, say, an exact-length mismatch.
  for (const c of candidates) {
    if (c.mobilePrefixes.length > 0) return c;
  }
  return candidates[0] ?? null;
}

export function isSupportedCallingCode(callingCode: string): boolean {
  return findPlan(callingCode) !== null;
}
