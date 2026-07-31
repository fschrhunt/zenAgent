/**
 * Versioned, bounded page-interaction contracts.
 *
 * Page content is intentionally separate from BrowserSnapshot so it is never
 * retained in the global registry or broadcast as a browser delta.
 */

export const PAGE_SCHEMA_VERSION = 1;
export const MAX_PAGE_NODES = 5_000;
export const MAX_PAGE_FRAMES = 128;
export const MAX_PAGE_QUERY_RESULTS = 100;
export const MAX_PAGE_STRING_CHARS = 64 * 1024;
export const MAX_PAGE_SELECT_VALUES = 100;
export const MAX_PAGE_UPLOAD_FILES = 32;
export const MAX_PAGE_RESOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_PAGE_MEDIA_BYTES = 32 * 1024 * 1024;
export const MAX_PAGE_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_PAGE_SCREENSHOT_DIMENSION = 4_096;
export const MAX_PAGE_MEDIA = 100;
export const MAX_PAGE_CAPTION_CUES = 1_000;

export type PageLoadState = "loading" | "interactive" | "complete";
export type PageFrameAvailability = "available" | "stale" | "unsupported";

export interface PageFrame {
  readonly frameRef: string;
  readonly parentFrameRef: string | null;
  readonly documentId: string | null;
  readonly url: string;
  readonly loadState: PageLoadState | "unavailable";
  readonly availability: PageFrameAvailability;
}

export type PageActionHint =
  | "click"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "check"
  | "submit"
  | "upload"
  | "open-background";

export interface PageNodeGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportX: number;
  readonly viewportY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export type PageShadowRootBoundary = "none" | "open" | "closed";

export interface PageSemanticState {
  readonly disabled: boolean | null;
  readonly editable: boolean;
  readonly checked: boolean | null;
  readonly selected: boolean | null;
  readonly expanded: boolean | null;
  readonly pressed: boolean | null;
  readonly required: boolean | null;
  readonly readonly: boolean | null;
  readonly invalid: boolean;
  readonly level: number | null;
  readonly orientation: string | null;
}

export interface PageSemanticNode {
  readonly elementRef: string;
  readonly frameRef: string;
  readonly parentElementRef: string | null;
  readonly role: string | null;
  readonly name: string;
  readonly visibleText: string;
  readonly visible: boolean;
  readonly geometry: PageNodeGeometry;
  /**
   * Closed roots are reported as a boundary and are never traversed.
   * `open` means children from the root may appear later in the snapshot.
   */
  readonly shadowRoot: PageShadowRootBoundary;
  /** Safe static HTTP(S) destination for a link that requests a new context. */
  readonly backgroundUrl?: string;
  readonly state: PageSemanticState;
  readonly actionHints: readonly PageActionHint[];
}

export interface PageTruncation {
  readonly frames: boolean;
  readonly nodes: boolean;
  readonly strings: boolean;
  readonly totalBytes: boolean;
}

export interface PageSnapshot {
  readonly schemaVersion: typeof PAGE_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly documentId: string;
  readonly tabId: string;
  readonly capturedAt: string;
  readonly url: string;
  readonly title: string;
  readonly loadState: PageLoadState;
  readonly rootFrameRef: string;
  readonly frames: readonly PageFrame[];
  readonly nodes: readonly PageSemanticNode[];
  readonly truncation: PageTruncation;
}

export type PageLocator =
  | Readonly<{ kind: "role"; role: string; name?: string }>
  | Readonly<{ kind: "label"; label: string }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "placeholder"; placeholder: string }>
  | Readonly<{ kind: "css"; selector: string }>
  | Readonly<{ kind: "element"; elementRef: string }>;

export interface PageFrameTarget {
  readonly tabId: string;
  readonly documentId: string;
  readonly snapshotId: string;
  readonly frameRef: string;
}

export interface PageElementTarget extends PageFrameTarget {
  readonly elementRef: string;
}

export interface PageDocumentTarget {
  readonly tabId: string;
  readonly documentId: string;
}

export interface PageQueryResult {
  readonly nodes: readonly PageSemanticNode[];
  readonly truncated: boolean;
}

export interface PageMutationResult {
  readonly performed: true;
  /**
   * The generation on which the operation was attempted. A navigation the
   * operation initiates may replace it immediately after this response.
   */
  readonly documentId: string;
}

export interface PagePressOptions {
  readonly key: string;
  readonly code?: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface PageScreenshotOptions {
  readonly scale?: number;
  readonly background?: string;
}

export interface PageScreenshotResult {
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly dataBase64: string;
}

export interface PageUploadResult extends PageMutationResult {
  readonly fileCount: number;
}

export interface PageCaptionCue {
  readonly startTime: number;
  readonly endTime: number;
  readonly text: string;
}

export interface PageCaptionTrack {
  readonly kind: string;
  readonly label: string;
  readonly language: string;
  readonly mode: "disabled" | "hidden" | "showing";
  readonly cues: readonly PageCaptionCue[];
  readonly cuesAvailable: boolean;
  readonly truncated: boolean;
}

export interface PageMedia {
  readonly elementRef: string;
  readonly frameRef: string;
  readonly kind: "audio" | "video";
  readonly sourceUrl: string;
  readonly duration: number | null;
  readonly currentTime: number;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly readyState: number;
  readonly drm: boolean;
  readonly captions: readonly PageCaptionTrack[];
}

export interface PageMediaListResult {
  readonly media: readonly PageMedia[];
  readonly truncated: boolean;
}

export interface PageResourceResult {
  readonly mimeType: string;
  readonly bytes: number;
  readonly dataBase64: string;
}

export type PageDialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

export interface PageDialog {
  readonly dialogRef: string;
  readonly tabId: string;
  readonly documentId: string;
  readonly kind: PageDialogKind;
  readonly message: string;
}

export interface PageDialogListResult {
  readonly dialogs: readonly PageDialog[];
}

export interface PageDialogResponse {
  readonly accept: boolean;
  readonly text?: string;
}
