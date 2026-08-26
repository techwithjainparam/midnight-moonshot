// PRIESTATE — Extraction-to-form merge rule (FEATURE 2).
//
// Pure, side-effect-free core of the auto-fill behavior in
// RegisterPage.handleExtracted so it can be unit-tested:
//
//   * A field the user has edited manually (dirty) is NEVER overwritten.
//   * Empty string fields and the untouched default property value
//     (0n) are filled from the document extraction.
//   * Every applied key is reported so the UI can badge it
//     "Extracted from document"; nothing is silently submitted.

import type { ExtractedFields } from './types';

export interface ExtractableFormValues {
  ownerName: string;
  propertyType: string;
  surveyNumber: string;
  landArea: string;
  location: string;
  propertyValue: bigint;
}

/**
 * Merge extracted fields into a registration form.
 * Returns the merged form plus the set of keys that were applied.
 */
export function applyExtractedFields<F extends ExtractableFormValues>(
  form: F,
  extracted: ExtractedFields,
  dirtyKeys: ReadonlySet<string>,
): { form: F; applied: Set<string> } {
  const next = { ...form };
  const applied = new Set<string>();

  const canFill = (key: keyof ExtractableFormValues): boolean => {
    if (dirtyKeys.has(key)) return false;
    if (key === 'propertyValue') return next.propertyValue === 0n;
    // propertyType has a non-empty default ('Residential'); it may only be
    // replaced while still untouched (checked above).
    if (key === 'propertyType') return true;
    return typeof next[key] === 'string' && (next[key] as string) === '';
  };

  const tryFill = (key: keyof ExtractableFormValues, value: string | undefined): void => {
    if (!value || !canFill(key)) return;
    if (key === 'propertyValue') {
      const digits = value.replace(/[^\d]/g, '');
      try {
        next.propertyValue = digits ? BigInt(digits) : 0n;
      } catch {
        next.propertyValue = 0n;
      }
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
    applied.add(key);
  };

  tryFill('ownerName', extracted.ownerName);
  tryFill('propertyType', extracted.propertyType);
  tryFill('surveyNumber', extracted.surveyNumber);
  tryFill('landArea', extracted.landArea);
  tryFill('location', extracted.location);
  tryFill('propertyValue', extracted.propertyValue);

  return { form: next, applied };
}
