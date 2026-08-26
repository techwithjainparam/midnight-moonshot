import { useState, useCallback, useRef, useEffect } from 'react';
import {
  SUPPORTED_DOC_EXTENSIONS,
  formatFileSize,
  isSupportedDocType,
  type ExtractionResult,
  type UploadedDocumentMeta,
} from '../documents/types';
import { defaultExtractionProvider } from '../documents/extraction-provider';
import { saveDocumentMeta } from '../documents/document-store';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

type UploadPhase =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'processing' }
  | { kind: 'done'; result: ExtractionResult; meta: UploadedDocumentMeta }
  | { kind: 'error'; message: string };

interface DocumentUploadProps {
  ownerAddress: string;
  onExtracted: (result: ExtractionResult) => void;
  onRemoved: () => void;
}

function statusPillClass(status: ExtractionResult['status']): string {
  switch (status) {
    case 'EXTRACTION_COMPLETE': return 'doc-status-complete';
    case 'MISSING_INFORMATION': return 'doc-status-missing';
    case 'POTENTIAL_INCONSISTENCY':
    case 'NEEDS_REVIEW': return 'doc-status-review';
    case 'UNSUPPORTED_DOCUMENT': return 'doc-status-unsupported';
    default: return '';
  }
}

// FEATURE 2 — "Upload Property Document".
//
// Local demo upload: there is no backend, so the file is read in-browser
// only (never transmitted or persisted). Progress reflects the local
// read + simulated transfer so the UX states are exercised:
//   selected → uploading → processing → extracted | error
export default function DocumentUpload({ ownerAddress, onExtracted, onRemoved }: DocumentUploadProps) {
  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(() => () => {
    timersRef.current.forEach((t) => window.clearInterval(t));
    timersRef.current = [];
  }, []);

  const handleFile = useCallback((selected: File | undefined | null) => {
    if (!selected || !ownerAddress) return;

    if (!isSupportedDocType(selected.type, selected.name)) {
      setFile(selected);
      setPhase({ kind: 'error', message: 'Unsupported file type. Please upload a PDF, JPG/JPEG, or PNG document.' });
      return;
    }
    if (selected.size > MAX_FILE_SIZE) {
      setFile(selected);
      setPhase({ kind: 'error', message: `File is too large (${formatFileSize(selected.size)}). Maximum size is 10 MB.` });
      return;
    }

    setFile(selected);
    setPhase({ kind: 'uploading', progress: 0 });

    // Simulated local upload progress (no backend exists to report real
    // progress). The file itself is never sent anywhere.
    const timer = window.setInterval(() => {
      setPhase((prev) => {
        if (prev.kind !== 'uploading') return prev;
        const next = prev.progress + 12 + Math.random() * 10;
        if (next < 100) return { kind: 'uploading', progress: next };
        window.clearInterval(timer);
        setPhase({ kind: 'processing' });
        void processSelected(selected);
        return prev;
      });
    }, 160);
    timersRef.current.push(timer);
  }, [ownerAddress]);

  const processSelected = useCallback(async (selected: File) => {
    try {
      // DEMO extraction — filename-based, fully local (see provider docs).
      const result = await defaultExtractionProvider.extract(selected);
      const meta: UploadedDocumentMeta = {
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ownerAddress: ownerAddress.trim().toLowerCase(),
        fileName: selected.name,
        fileType: selected.type || selected.name.split('.').pop()?.toUpperCase() || 'unknown',
        fileSize: selected.size,
        uploadedAt: new Date().toISOString(),
        extraction: result,
      };
      saveDocumentMeta(meta);
      setPhase({ kind: 'done', result, meta });
      onExtracted(result);
    } catch {
      setPhase({ kind: 'error', message: 'Document processing failed. You can continue entering details manually.' });
    }
  }, [ownerAddress, onExtracted]);

  const handleRemove = useCallback(() => {
    setFile(null);
    setPhase({ kind: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
    onRemoved();
  }, [onRemoved]);

  const handleReplace = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const busy = phase.kind === 'uploading' || phase.kind === 'processing';

  return (
    <div className="doc-upload">
      <div className="doc-upload-header">
        <h3 className="doc-upload-title">Upload Property Document</h3>
        <p className="doc-upload-sub">
          Upload a property document to automatically extract available property
          information.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={SUPPORTED_DOC_EXTENSIONS}
        className="visually-hidden"
        aria-label="Upload property document (PDF, JPG, PNG)"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {(phase.kind === 'idle' || phase.kind === 'error') && (
        <button
          type="button"
          className={`doc-dropzone${phase.kind === 'error' ? ' doc-dropzone-error' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>
          </svg>
          <span className="doc-dropzone-main">Click to select a document, or drag it here</span>
          <span className="doc-dropzone-hint">PDF, JPG/JPEG, PNG · up to 10 MB</span>
        </button>
      )}

      {file && (
        <div className="doc-file-chip">
          <span className="doc-file-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </span>
          <span className="doc-file-name" title={file.name}>{file.name}</span>
          <span className="doc-file-meta">{file.type || 'document'} · {formatFileSize(file.size)}</span>
          {!busy && (
            <span className="doc-file-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleReplace}>Replace</button>
              <button type="button" className="btn btn-ghost btn-sm doc-remove-btn" onClick={handleRemove}>Remove</button>
            </span>
          )}
        </div>
      )}

      {phase.kind === 'uploading' && (
        <div className="doc-progress" role="status">
          <div className="doc-progress-bar" aria-hidden="true">
            <div className="doc-progress-fill" style={{ width: `${Math.min(100, phase.progress)}%` }} />
          </div>
          <span className="doc-progress-label">Uploading… {Math.min(100, Math.round(phase.progress))}%</span>
        </div>
      )}

      {phase.kind === 'processing' && (
        <div className="doc-processing" role="status">
          <span className="doc-spinner" aria-hidden="true"/>
          <span>Processing document… running document analysis assistant.</span>
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="status-msg error doc-error" role="alert">{phase.message}</div>
      )}

      {phase.kind === 'done' && (
        <div className="doc-result">
          <div className="doc-result-row">
            <span className={`doc-status-pill ${statusPillClass(phase.result.status)}`}>
              {phase.result.status.replace(/_/g, ' ')}
            </span>
            {phase.result.documentTypeLabel && (
              <span className="doc-type-label">Identified as: {phase.result.documentTypeLabel}</span>
            )}
          </div>

          <p className="doc-analysis-note">
            Document analysis assistant result — advisory only. This does NOT
            certify that the document is legally valid; final verification is
            performed by the authorized officer.
          </p>

          {phase.result.findings.length > 0 && (
            <ul className="doc-findings">
              {phase.result.findings.map((f, i) => (
                <li key={i} className={`doc-finding doc-finding-${f.severity}`}>{f.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
