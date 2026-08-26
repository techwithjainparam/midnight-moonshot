export type ApplicationStatus = 'DRAFT' | 'SUBMITTED' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export type ZKProofStatus = 'NOT_STARTED' | 'ZK_PROOF_PENDING' | 'ZK_PROOF_VALID' | 'ZK_PROOF_FAILED';

export interface MockProperty {
  id: string;
  ownerName: string;
  propertyId: string;
  surveyNumber: string;
  location: string;
  village: string;
  taluka: string;
  district: string;
  state: string;
  landArea: string;
  propertyType: string;
  registrationStatus: ApplicationStatus;
  zkProofStatus: ZKProofStatus;
  recordReference: string;
  submittedDate: string | null;
  reviewedDate: string | null;
  lastUpdated: string;
  builderDeveloper: string;
  propertyImage: string;
  parcelMap: string;
  propertyValue: bigint;
  eligibilityThreshold: bigint;
  officerNotes: string;
}

export const MOCK_PROPERTIES: MockProperty[] = [
  {
    id: 'reg-001',
    ownerName: 'Asha Mehta',
    propertyId: 'PR-2024-00847',
    surveyNumber: 'Gat No. 124/A',
    location: 'Plot 7, Green Valley Layout',
    village: 'Wadgaon Sheri',
    taluka: 'Haveli',
    district: 'Pune',
    state: 'Maharashtra',
    landArea: '2,400 sq ft',
    propertyType: 'Residential',
    registrationStatus: 'APPROVED',
    zkProofStatus: 'ZK_PROOF_VALID',
    recordReference: 'REG/MH/PN/2024/00847',
    submittedDate: '2024-11-10',
    reviewedDate: '2024-11-15',
    lastUpdated: '2024-11-15',
    builderDeveloper: 'Green Valley Constructions Pvt. Ltd.',
    propertyImage: '',
    parcelMap: '',
    propertyValue: 1250000n,
    eligibilityThreshold: 1000000n,
    officerNotes: 'All documents verified. Eligibility confirmed via ZK proof.',
  },
  {
    id: 'reg-002',
    ownerName: 'Vikram Deshmukh',
    propertyId: 'PR-2024-01203',
    surveyNumber: 'Gat No. 56/B',
    location: 'Survey 56, Hinjewadi Phase III',
    village: 'Hinjewadi',
    taluka: 'Mulshi',
    district: 'Pune',
    state: 'Maharashtra',
    landArea: '1,800 sq ft',
    propertyType: 'Residential',
    registrationStatus: 'APPROVED',
    zkProofStatus: 'ZK_PROOF_VALID',
    recordReference: 'REG/MH/PN/2024/01203',
    submittedDate: '2024-10-18',
    reviewedDate: '2024-10-22',
    lastUpdated: '2024-10-22',
    builderDeveloper: 'Hinjewadi Realty Corp.',
    propertyImage: '',
    parcelMap: '',
    propertyValue: 950000n,
    eligibilityThreshold: 1000000n,
    officerNotes: 'Documents verified. Property value below eligibility threshold.',
  },
  {
    id: 'reg-003',
    ownerName: 'Priya Kulkarni',
    propertyId: 'PR-2024-00312',
    surveyNumber: 'CTS No. 7890',
    location: '14/B, FC Road',
    village: 'Shivajinagar',
    taluka: 'Haveli',
    district: 'Pune',
    state: 'Maharashtra',
    landArea: '1,200 sq ft',
    propertyType: 'Commercial',
    registrationStatus: 'PENDING_REVIEW',
    zkProofStatus: 'NOT_STARTED',
    recordReference: 'REG/MH/PN/2024/00312',
    submittedDate: '2024-12-01',
    reviewedDate: null,
    lastUpdated: '2024-12-01',
    builderDeveloper: '',
    propertyImage: '',
    parcelMap: '',
    propertyValue: 2100000n,
    eligibilityThreshold: 1000000n,
    officerNotes: '',
  },
  {
    id: 'reg-004',
    ownerName: 'Rajan Patil',
    propertyId: 'PR-2023-04521',
    surveyNumber: 'Gat No. 312',
    location: 'Agricultural Plot, Talawade',
    village: 'Talawade',
    taluka: 'Mulshi',
    district: 'Pune',
    state: 'Maharashtra',
    landArea: '5 acres',
    propertyType: 'Agricultural',
    registrationStatus: 'APPROVED',
    zkProofStatus: 'ZK_PROOF_VALID',
    recordReference: 'REG/MH/PN/2023/04521',
    submittedDate: '2023-08-05',
    reviewedDate: '2023-08-10',
    lastUpdated: '2023-08-10',
    builderDeveloper: '',
    propertyImage: '',
    parcelMap: '',
    propertyValue: 3500000n,
    eligibilityThreshold: 1000000n,
    officerNotes: 'Agricultural land. All documentation verified.',
  },
  {
    id: 'reg-005',
    ownerName: 'Sunita Joshi',
    propertyId: 'PR-2024-00891',
    surveyNumber: 'Gat No. 45/C',
    location: 'Plot 22, Kothrud Industrial Area',
    village: 'Kothrud',
    taluka: 'Haveli',
    district: 'Pune',
    state: 'Maharashtra',
    landArea: '3,200 sq ft',
    propertyType: 'Industrial',
    registrationStatus: 'SUBMITTED',
    zkProofStatus: 'NOT_STARTED',
    recordReference: 'REG/MH/PN/2024/00891',
    submittedDate: '2024-12-05',
    reviewedDate: null,
    lastUpdated: '2024-12-05',
    builderDeveloper: 'Kothrud Industrial Developers',
    propertyImage: '',
    parcelMap: '',
    propertyValue: 4200000n,
    eligibilityThreshold: 1000000n,
    officerNotes: '',
  },
  {
    id: 'reg-006',
    ownerName: 'Anil Kharde',
    propertyId: 'PR-2024-00654',
    surveyNumber: 'CTS No. 2345',
    location: 'Plot 9, Wakad-Pimpri Road',
    village: 'Wakad',
    taluka: 'Haveli',
    district: 'Pune',
    state: 'Maharashtra',
    landArea: '2,100 sq ft',
    propertyType: 'Residential',
    registrationStatus: 'REJECTED',
    zkProofStatus: 'ZK_PROOF_FAILED',
    recordReference: 'REG/MH/PN/2024/00654',
    submittedDate: '2024-09-14',
    reviewedDate: '2024-09-18',
    lastUpdated: '2024-09-18',
    builderDeveloper: '',
    propertyImage: '',
    parcelMap: '',
    propertyValue: 880000n,
    eligibilityThreshold: 1000000n,
    officerNotes: 'Incomplete documentation. Survey number could not be verified.',
  },
  {
    id: 'reg-007',
    ownerName: 'Deepa Nair',
    propertyId: 'PR-2024-01456',
    surveyNumber: 'Gat No. 78/D',
    location: 'Row House 12, Baner Hills',
    village: 'Baner',
    taluka: 'Mulshi',
    district: 'Pune',
    state: 'Maharashtra',
    landArea: '1,600 sq ft',
    propertyType: 'Residential',
    registrationStatus: 'DRAFT',
    zkProofStatus: 'NOT_STARTED',
    recordReference: '',
    submittedDate: null,
    reviewedDate: null,
    lastUpdated: '2024-12-08',
    builderDeveloper: 'Baner Heights Builders',
    propertyImage: '',
    parcelMap: '',
    propertyValue: 1500000n,
    eligibilityThreshold: 1000000n,
    officerNotes: '',
  },
];

export const getPropertyById = (id: string): MockProperty | undefined =>
  MOCK_PROPERTIES.find((p) => p.id === id);

export function newRegistrationId(): string {
  const n = MOCK_PROPERTIES.length + 1;
  return `reg-${String(n).padStart(3, '0')}`;
}
