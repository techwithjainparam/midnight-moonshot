// PRIESTATE — Document extraction provider abstraction (FEATURE 2).
//
// ═══════════════════════════════════════════════════════════════════
// ⚠️  DOCUMENT ANALYSIS ASSISTANT — NOT A LEGAL AUTHORITY
// ═══════════════════════════════════════════════════════════════════
// Extraction/analysis may: identify the document type, extract fields,
// detect missing expected fields, detect obvious inconsistencies, and
// flag suspicious/incomplete documents for review.
//
// It MUST NOT and DOES NOT claim legal document validity. No "100%
// valid" / "guaranteed genuine" outputs exist by design — only the
// statuses in ExtractionStatus. Final legal validity remains with the
// authorized officer / appropriate authoritative government verification.
//
// ═══════════════════════════════════════════════════════════════════
// ⚠️  DEMO EXTRACTION — NOT PRODUCTION OCR/AI
// ═══════════════════════════════════════════════════════════════════
// No OCR/AI provider is configured in this project, and no API keys are
// invented or assumed. `DemoLocalExtractionProvider` performs a safe,
// fully local extraction based on the file NAME only (never file
// contents) so the UX flow can be exercised end-to-end:
//
//   "Gat-124-A_Asha-Mehta_2400sqft_pune.pdf"
//     → surveyNumber "Gat No. 124/A", ownerName "Asha Mehta", …
//
// What a PRODUCTION integration would require (none of it exists here):
//   * A server-side OCR/document-AI service (e.g. a managed OCR API).
//   * API keys held ONLY on the server (env-injected); never shipped to
//     the browser. The browser would call our backend, which proxies to
//     the provider.
//   * Encrypted document storage with per-user access control and audit
//     logging; retention policy; officer access via authenticated,
//     authorized document retrieval endpoints.
//   * Human review workflow — extracted data is always advisory.
// ═══════════════════════════════════════════════════════════════════

import {
  isSupportedDocType,
  type ExtractionFinding,
  type ExtractionResult,
  type ExtractedFields,
} from './types';

export interface DocumentExtractionProvider {
  /** Identifier recorded on every result for traceability. */
  readonly name: string;
  readonly displayName: string;
  isSupported(fileType: string, fileName: string): boolean;
  extract(file: File): Promise<ExtractionResult>;
}

interface ParsedNameFields {
  surveyNumber?: string;
  ownerName?: string;
  landArea?: string;
  location?: string;
  documentNumber?: string;
}

/**
 * Normalize a document file name for hint parsing: strip the extension
 * and turn separators ("_", "-") into single spaces.
 */
export function normalizeDocFileName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse structured hints out of a document FILE NAME.
 * Deterministic: the same name always yields the same fields.
 */
export function parseFileNameHints(fileName: string): ParsedNameFields {
  const normalized = normalizeDocFileName(fileName);
  const fields: ParsedNameFields = {};

  // Survey / Gat / CTS numbers: "Gat 124 A", "Survey 56 B", "CTS 7890".
  const gat = normalized.match(/\b(?:gat|survey|srv)\s*(?:no\.?\s*)?(\d+[a-z]?(?:\s*[/\\]\s*[a-z0-9]+)?)/i);
  if (gat) {
    const raw = gat[1].toUpperCase().replace(/\s*[/\\]\s*/, '/');
    const prefix = /\bcts\b/i.test(normalized) ? 'CTS No.' : /\bsurvey|srv\b/i.test(normalized) ? 'Survey No.' : 'Gat No.';
    fields.surveyNumber = `${prefix} ${raw}`;
  } else {
    const cts = normalized.match(/\bcts\s*(?:no\.?\s*)?(\d+)/i);
    if (cts) fields.surveyNumber = `CTS No. ${cts[1]}`;
  }

  // Land area: "2400sqft", "2,400 sq ft", "2.4 acre", "5 acres", "1200 sqm".
  const area = normalized.match(/(\d[\d,.]*)\s*(sq\.?\s*(?:ft|feet|meter|m)|acre[s]?|hectare[s]?)/i);
  if (area) {
    const unitRaw = area[2].toLowerCase().replace(/\s+/g, '');
    const unit = unitRaw.startsWith('acre') ? 'acres'
      : unitRaw.startsWith('hectare') ? 'hectares'
      : unitRaw.includes('meter') || unitRaw.endsWith('m') ? 'sq m' : 'sq ft';
    fields.landArea = `${area[1].replace(/,$/, '')} ${unit}`;
  }

  // Document number: "doc 2024/00847", "reg no 123", "deed 456".
  const docNo = normalized.match(/\b(?:doc(?:ument)?|reg(?:istration)?|deed)\s*(?:no\.?|number)?\s*([a-z0-9][a-z0-9/-]{3,})/i);
  if (docNo) fields.documentNumber = docNo[1].toUpperCase();

  // Owner name: two consecutive capitalized words not part of another match.
  const stripped = normalized
    .replace(/\b(?:gat|survey|srv|cts|no|doc|document|reg|registration|deed|title|sale|agreement|card|extract|7\s*12|satbara|utara|property|scan|copy|draft|signed)\b/gi, ' ')
    .replace(/\d[\d,.]*\s*(?:sq\.?\s*(?:ft|feet|meter|m)|acres?|hectares?)/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = stripped.match(/\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\s+([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\b/);
  if (name) fields.ownerName = `${name[1]} ${name[2]}`;

  // Location: single capitalized token after "pune"/"mumbai"-style city names
  // or a trailing capitalized word that looks like a place.
  const place = stripped.match(/\b(Pune|Mumbai|Nashik|Nagpur|Thane|Baner|Wakad|Hinjewadi|Kothrud)\b/i);
  if (place) fields.location = place[1].replace(/^./, (c) => c.toUpperCase());

  return fields;
}

const EXPECTED_CORE_FIELDS = ['ownerName', 'propertyType', 'surveyNumber', 'landArea'] as const;

/**
 * DEMO provider — local, offline, filename-based extraction.
 * Never reads file contents; never touches the network.
 */
export class DemoLocalExtractionProvider implements DocumentExtractionProvider {
  readonly name = 'demo-local-filename';
  readonly displayName = 'Document analysis assistant (DEMO — local)';

  isSupported(fileType: string, fileName: string): boolean {
    return isSupportedDocType(fileType, fileName);
  }

  async extract(file: File): Promise<ExtractionResult> {
    if (!this.isSupported(file.type, file.name)) {
      return {
        status: 'UNSUPPORTED_DOCUMENT',
        fields: {},
        findings: [{
          severity: 'warning',
          message: 'Unsupported document format. Supported formats are PDF, JPG/JPEG and PNG.',
        }],
        provider: this.name,
      };
    }

    const hints = parseFileNameHints(file.name);
    const fields: ExtractedFields = { ...hints };
    const findings: ExtractionFinding[] = [];

    // Identify a plausible document-type label from the name (advisory only).
    let documentTypeLabel: string | undefined;
    const lower = file.name.toLowerCase();
    if (/7\s*12|satbara/.test(lower)) documentTypeLabel = '7/12 extract (satbara utara)';
    else if (/sale|deed/.test(lower)) documentTypeLabel = 'Sale deed';
    else if (/title/.test(lower)) documentTypeLabel = 'Title document';
    else if (/property\s*card/.test(lower)) documentTypeLabel = 'Property card';
    else if (/agreement/.test(lower)) documentTypeLabel = 'Agreement';
    else documentTypeLabel = 'Property-related document';
    if (documentTypeLabel !== 'Property-related document') {
      fields.propertyType = /agricult|farm/.test(lower)
        ? 'Agricultural'
        : /industr/.test(lower)
          ? 'Industrial'
          : /commerc|shop|office/.test(lower)
            ? 'Commercial'
            : 'Residential';
    }
    if (!fields.propertyType) fields.propertyType = 'Residential';

    // Missing expected fields → MISSING_INFORMATION.
    const missing = EXPECTED_CORE_FIELDS.filter((k) => !fields[k]);
    if (missing.length > 0) {
      findings.push({
        severity: 'info',
        message: `Could not read from the file name: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}. Enter these manually.`,
      });
    }

    // Obvious inconsistency heuristic: two different survey identifiers.
    // Matched against the normalized name so separators such as "_" do not
    // defeat word-boundary detection.
    const normalizedName = normalizeDocFileName(file.name);
    const hasGat = /\bgat\b/i.test(normalizedName);
    const hasCts = /\bcts\b/i.test(normalizedName);
    if (hasGat && hasCts) {
      findings.push({
        severity: 'warning',
        message: 'Both a Gat number and a CTS number appear in the document name. Confirm which identifier applies.',
      });
    }

    // Suspicious/incomplete heuristics (advisory flags only).
    if (/\b(copy|draft|unsigned|scan[_ -]?quality[_ -]?low)\b/i.test(lower)) {
      findings.push({
        severity: 'warning',
        message: 'The file name suggests this may be a copy, draft, or low-quality scan. The original document should be reviewed.',
      });
    }

    let status: ExtractionResult['status'];
    if (findings.some((f) => f.severity === 'warning')) {
      status = 'POTENTIAL_INCONSISTENCY';
    } else if (missing.length > 0) {
      status = 'MISSING_INFORMATION';
    } else {
      status = 'EXTRACTION_COMPLETE';
      findings.push({
        severity: 'info',
        message: 'All expected fields were read from the file name. Review every value before continuing — automated extraction can be wrong.',
      });
    }

    return {
      status,
      fields,
      documentTypeLabel,
      findings,
      provider: this.name,
    };
  }
}

const FIELD_LABELS: Record<string, string> = {
  ownerName: 'Owner name',
  propertyType: 'Property type',
  surveyNumber: 'Survey/Gat number',
  landArea: 'Land area',
};

/** Default provider used by the app until a production provider exists. */
export const defaultExtractionProvider: DocumentExtractionProvider =
  new DemoLocalExtractionProvider();
