// PRIESTATE — Property document types (FEATURE 2).
//
// A property document (title deed, 7/12 extract, sale deed, etc.) is
// uploaded by its owner to assist registration. Documents may contain
// sensitive personal information:
//
//   * Raw file contents are NEVER persisted anywhere in this demo and
//     NEVER placed on any public surface (registry, property cards,
//     public URLs, blockchain). Only lightweight metadata + the fields
//     the owner chose to keep live client-side are stored per-user.
//   * The private property value is deliberately NOT part of the public
//     extraction display; it remains a private ZK witness exactly as
//     before.
//
// Document analysis is an ASSISTANT, not a legal authority. It must
// never claim legal validity ("100% valid", "guaranteed genuine"). Use
// only the statuses below; final legal validity rests with the
// authorized officer / appropriate government verification.

export type ExtractionStatus =
  | 'EXTRACTION_COMPLETE'
  | 'NEEDS_REVIEW'
  | 'MISSING_INFORMATION'
  | 'POTENTIAL_INCONSISTENCY'
  | 'UNSUPPORTED_DOCUMENT';

export interface ExtractedFields {
  ownerName?: string;
  propertyType?: string;
  surveyNumber?: string;
  landArea?: string;
  location?: string;
  /** Document/registration number printed on the deed. */
  documentNumber?: string;
  registrationDate?: string;
  /**
   * PRIVATE — if explicitly present on the document. Never rendered
   * outside the private "Property Value" form field; never displayed in
   * the registry or on public surfaces. Feeds only the existing private
   * ZK witness input.
   */
  propertyValue?: string;
}

export interface ExtractionFinding {
  severity: 'info' | 'warning';
  message: string;
}

export interface ExtractionResult {
  status: ExtractionStatus;
  fields: ExtractedFields;
  /** Human label of the identified document type, e.g. "Property card". */
  documentTypeLabel?: string;
  findings: ExtractionFinding[];
  /** Identifier of the provider that produced this result. */
  provider: string;
}

export interface UploadedDocumentMeta {
  id: string;
  /** Wallet address of the user who uploaded the document. */
  ownerAddress: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedAt: string;
  /** Registration application this document belongs to (when submitted). */
  linkedApplicationId?: string;
  extraction: ExtractionResult;
}

export const SUPPORTED_DOC_TYPES: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
];

export const SUPPORTED_DOC_EXTENSIONS = '.pdf,.jpg,.jpeg,.png';

export function isSupportedDocType(fileType: string, fileName: string): boolean {
  if (SUPPORTED_DOC_TYPES.includes(fileType)) return true;
  // Some browsers report empty MIME types — fall back to extension.
  const lower = fileName.toLowerCase();
  return /\.(pdf|jpe?g|png)$/.test(lower);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
