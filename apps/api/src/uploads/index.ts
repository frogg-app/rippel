/**
 * Public surface of the uploads layer. The routes are the only consumer today;
 * the orchestrator will want `resolveUploadStorageKey` when it turns an
 * `ImageSource` of `{ from: 'upload' }` into bytes to push to a backend.
 */

export type { UploadAccess, UploadKeyRow } from './access.js';
export { resolveUploadForRead } from './access.js';

export type {
  InspectedUpload,
  StoreUploadOptions,
  UploadDb,
  UploadRejectionCode,
  UploadRow,
} from './store.js';
export {
  ACCEPTED_UPLOAD_TYPES,
  UploadRejected,
  inspectUpload,
  rowToUpload,
  storeUpload,
  uploadUrls,
} from './store.js';

export { default as uploadRoutes } from './routes.js';
