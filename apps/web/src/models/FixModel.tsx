import { useEffect, useState } from 'react';
import type { ModelFileOperation } from '@comfy/shared';
import { request } from '../lib/api';
import { formatBytes } from './catalogue';

export function OperationProgress({ operation, onChange, onDone }: {
  operation: ModelFileOperation; onChange: (operation: ModelFileOperation) => void; onDone?: () => void;
}) {
  useEffect(() => {
    if (!['starting','running'].includes(operation.status)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void request<{ operation: ModelFileOperation }>(`/model-operations/${operation.id}`, { signal: controller.signal })
        .then(({ operation: next }) => { if (!controller.signal.aborted) { onChange(next); if (next.status === 'done' || next.status === 'failed') onDone?.(); } })
        .catch(() => {});
    }, 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [operation.id, operation.status, onChange, onDone]);
  const step = operation.steps[operation.step_index];
  return <div aria-live="polite">
    {operation.status === 'running' || operation.status === 'starting' ? <p>
      Step {operation.step_index + 1} of {operation.steps.length}: {step?.kind === 'move' ? 'Moving' : 'Downloading'}
      {operation.progress?.bytesReceived !== undefined ? ` · ${formatBytes(operation.progress.bytesReceived)}${operation.progress.bytesTotal && operation.progress.bytesTotal > 0 ? ` / ${formatBytes(operation.progress.bytesTotal)}` : ''}` : ''}
    </p> : null}
    {operation.status === 'done' ? <p>File operations finished. Model status has been re-checked.</p> : null}
    {operation.error ? <p role="alert">{operation.error}</p> : null}
  </div>;
}
export function OperationConfirmation({ operation, onChange }: { operation: ModelFileOperation; onChange: (value: ModelFileOperation) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bytes = operation.steps.reduce((sum, step) => sum + (step.kind === 'download' ? step.request.sizeBytes ?? 0 : 0), 0);
  return <div>
    <ol>{operation.steps.map((step, index) => <li key={index}>{step.kind === 'move'
      ? <>{step.request.from} → {step.request.to}. No download.</>
      : <>{step.request.path} · {formatBytes(step.request.sizeBytes ?? 0)} · <a href={step.request.url} target="_blank" rel="noreferrer">Source</a></>}</li>)}</ol>
    {bytes ? <p>Total download: {formatBytes(bytes)}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError('');
      void request<{ operation: ModelFileOperation }>(`/model-operations/${operation.id}/start`, { method: 'POST' })
        .then(({ operation: next }) => onChange(next)).catch((error) => setError(error.message)).finally(() => setBusy(false));
    }}>Confirm file changes</button>
  </div>;
}
export function FixModel({ modelId, backendId, onDone }: { modelId: string; backendId: string; onDone?: () => void }) {
  const [operation, setOperation] = useState<ModelFileOperation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setOperation(null);
    void request<{ operation: ModelFileOperation | null }>(`/models/${modelId}/fix?backendId=${backendId}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setOperation(result.operation); }).catch(() => {});
    return () => controller.abort();
  }, [modelId, backendId]);
  return <div>
    {!operation || operation.status === 'failed' || operation.status === 'done' ? <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError('');
      void request<{ operation: ModelFileOperation; unavailable: string[] }>(`/models/${modelId}/fix-plan`, { method: 'POST', body: { backendId } })
        .then((result) => { setOperation(result.operation); setError(result.unavailable.join(' ')); })
        .catch((error) => setError(error.message)).finally(() => setBusy(false));
    }}>{busy ? 'Checking fix…' : operation?.status === 'failed' ? 'Retry fix' : 'Fix'}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {operation?.status === 'planned' ? <OperationConfirmation operation={operation} onChange={setOperation} /> : null}
    {operation ? <OperationProgress operation={operation} onChange={setOperation} onDone={onDone} /> : null}
  </div>;
}
