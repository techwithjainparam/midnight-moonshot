// PRIESTATE — Demo seed data for application documents (FEATURE 2).
//
// The register flow stores documents for the CURRENT user only, but the
// Officer Portal must demonstrate access to "documents required for
// application review". Since there is no backend (and no real
// applicants), a few clearly-mock document records are seeded here and
// linked to mock applications that are under review (reg-003
// PENDING_REVIEW, reg-005 SUBMITTED).
//
// These seeds contain NO raw document contents — metadata and extracted
// fields only. Normal users can never see them: they are not the owner,
// and officer visibility is limited to applications under review.

import type { UploadedDocumentMeta } from './types';
import { saveDocumentMeta } from './document-store';

const DEMO_APPLICANT_A = 'demo-applicant-priya';
const DEMO_APPLICANT_B = 'demo-applicant-sunita';

let seeded = false;

export function seedDemoDocuments(): void {
  if (seeded) return;
  seeded = true;

  const docs: UploadedDocumentMeta[] = [
    {
      id: 'doc-seed-reg003-title',
      ownerAddress: DEMO_APPLICANT_A,
      fileName: 'Property-Card_CTS-7890_Priya-Kulkarni.pdf',
      fileType: 'application/pdf',
      fileSize: 482_133,
      uploadedAt: '2024-12-01T09:24:00.000Z',
      linkedApplicationId: 'reg-003',
      extraction: {
        status: 'EXTRACTION_COMPLETE',
        fields: {
          ownerName: 'Priya Kulkarni',
          propertyType: 'Commercial',
          surveyNumber: 'CTS No. 7890',
          landArea: '1,200 sq ft',
          location: '14/B, FC Road',
        },
        documentTypeLabel: 'Property card',
        findings: [
          {
            severity: 'info',
            message: 'All expected fields were read. Review every value before continuing.',
          },
        ],
        provider: 'demo-local-filename',
      },
    },
    {
      id: 'doc-seed-reg005-deed',
      ownerAddress: DEMO_APPLICANT_B,
      fileName: 'Sale-Deed_Gat-45-C_draft-copy_Sunita-Joshi.pdf',
      fileType: 'application/pdf',
      fileSize: 1_204_882,
      uploadedAt: '2024-12-05T14:02:00.000Z',
      linkedApplicationId: 'reg-005',
      extraction: {
        status: 'POTENTIAL_INCONSISTENCY',
        fields: {
          ownerName: 'Sunita Joshi',
          propertyType: 'Industrial',
          surveyNumber: 'Gat No. 45/C',
          landArea: '3,200 sq ft',
          location: 'Kothrud',
        },
        documentTypeLabel: 'Sale deed',
        findings: [
          {
            severity: 'warning',
            message: 'The file name suggests this may be a copy or draft. The original document should be reviewed.',
          },
        ],
        provider: 'demo-local-filename',
      },
    },
  ];

  for (const doc of docs) saveDocumentMeta(doc);
}
