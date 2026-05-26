// Type aliases re-exported from the EXR module so the components have a single
// import surface. The old HTTP `api/types.ts` contained these shapes; in the
// pure-browser build they live next to the code that produces them, and this
// file just stitches them together for component code.

export type {
  PassFamily,
  PassInfo,
  VizMode,
  FileMetadata,
} from '../exr/passes';

export type {
  CryptoCandidate,
  CryptoPickResult,
} from '../exr/crypto';
