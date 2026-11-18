// Type definitions for neuron-reporter

export type Status = 'COMPLETED' | 'FAILED' | 'WARNED' | 'PENDING' | 'SKIPPED';

export interface Attachment {
  name: string;
  /** e.g. 'text/plain', 'text/x-log', 'application/json', 'video/webm', 'image/png', 'application/zip', 'text/uri-list' */
  contentType: string;
  /** Text content (logs, JSON, plain text) */
  body?: string;
  /** Embedded binary content as a data: URI */
  dataUri?: string;
  /** A URL, or a file path (relative to the report, or to the input JSON for the CLI) */
  path?: string;
  size?: number;
}

export interface Attempt {
  status: Status;
  duration: number;
  error?: string;
}

export interface Node {
  description: string;
  status: Status;
  /** milliseconds */
  duration: number;
  isGroup: boolean;
  children: Node[];
  error?: string;
  detail?: string;
  screenshot?: { dataUri: string; caption: string };
  attachments?: Attachment[];
  /** Every try of this step/test when it was retried; the last one is the final outcome */
  attempts?: Attempt[];
  /** Failed at least once, then passed on a retry */
  flaky?: boolean;
  /** A stable identity for run history (survives renames). Without it, a step is known by its path. */
  id?: string;
  /** Override the classifier's cause key */
  category?: string;
}

export interface RunJSON {
  name: string;
  startedAt: string;
  duration: number;
  tree: Node[];
  labels?: Record<string, string>;
  runInfo?: Record<string, string>;
}

export interface Rule {
  key: string;
  label: string;
  type: 'defect' | 'script' | 'environment';
  hint?: string;
  test: RegExp | ((message: string) => boolean);
}

export interface Classifier {
  (message: string): Rule | { key: string; label: string; type: string; hint: string };
  info(key: string): { key: string; label: string; type: string; hint?: string };
}

export interface StepOptions {
  /** Retry a failing step this many times. A pass after a failure marks it flaky. */
  retries?: number;
  /** Milliseconds between attempts */
  retryDelay?: number;
  /** A stable identity for run history, so renaming the step keeps its history */
  id?: string;
}

export interface StepReporterOptions {
  screenshot?: () => Promise<string | Buffer | null> | string | Buffer | null;
  screenshotOnFailure?: boolean;
  history?: boolean | { dir?: string; maxRuns?: number };
  runInfo?: Record<string, unknown> | (() => Record<string, unknown>);
  highlights?: string[] | (() => string[]);
  labels?: Record<string, string> | (() => Record<string, string>);
  rules?: Rule[];
  console?: boolean;
  /** Default retries for step() and softStep() */
  retries?: number;
  retryDelay?: number;
  /** Secret redaction, on by default. false turns it off. */
  redact?: boolean | RedactOptions;
}

export interface RedactOptions {
  /** Exact strings to hide */
  values?: string[];
  /** Extra patterns to hide */
  patterns?: Array<RegExp | string>;
  /** Hide the values of secret-looking environment variables (default true) */
  env?: boolean;
  /** Default "••••••" */
  replacement?: string;
}

export type Redactor = ((text: string) => string) & { enabled: boolean };
export function createRedactor(opts?: boolean | RedactOptions): Redactor;

export interface MergedRun {
  name: string;
  startTime: number;
  duration: number;
  tree: Node[];
  labels: Record<string, string>;
  runInfo: Record<string, string>;
  shards: number;
  files: string[];
}
/** Merge run JSON files (or folders of them) from parallel jobs or shards into one run. */
export function mergeRuns(inputs: string | string[]): MergedRun;

export interface FileAttachOptions {
  /** 'auto' (default) embeds files up to maxEmbedBytes and links bigger ones */
  embed?: boolean | 'auto';
  maxEmbedBytes?: number;
  contentType?: string;
}

export interface Failure { testCase: string; step: string; category: string; message: string }
export interface FlakyStep { testCase: string; step: string; attempts: number; message: string }

export class StepReporter {
  constructor(name: string, options?: StepReporterOptions);
  name: string;
  root: Node[];
  step<T>(description: string, fn: (ctx: { attempt: number }) => T | Promise<T>, opts?: StepOptions): Promise<T>;
  softStep<T>(description: string, fn: (ctx: { attempt: number }) => T | Promise<T>, opts?: StepOptions): Promise<T | true | false>;
  optionalStep<T>(description: string, fn: (ctx: { attempt: number }) => T | Promise<T>, opts?: StepOptions): Promise<T>;
  group<T>(description: string, fn: () => T | Promise<T>, opts?: { id?: string }): Promise<T>;
  attachScreenshot(caption: string): Promise<void>;
  attachDetail(text: string): void;
  attach(name: string, content: string | Buffer | object, opts?: { contentType?: string }): Attachment | null;
  attachLog(name: string, lines: string | string[]): Attachment | null;
  attachFile(name: string, filePath: string, opts?: FileAttachOptions): Attachment | null;
  attachVideo(name: string, filePath: string, opts?: FileAttachOptions): Attachment | null;
  attachLink(name: string, url: string): Attachment | null;
  failures(): Failure[];
  flakySteps(): FlakyStep[];
  assertNoFailures(): void;
  toJSON(): RunJSON;
  /** Write this run as JSON (redacted) for `neuron-reporter merge` */
  writeJSON(outPath: string): string;
  writeReport(outPath: string): { path: string; counts: Record<string, number>; flaky: number; historyFile: string | null };
}

export interface RenderOptions {
  title: string;
  subtitle?: string;
  labels?: Record<string, string>;
  tree: Node[];
  history?: unknown[] | null;
  runInfo?: Record<string, unknown> | null;
  highlights?: string[];
  classify?: Classifier | null;
  redact?: boolean | RedactOptions | Redactor;
}

export function render(opts: RenderOptions): string;
export function writeReport(outPath: string, opts: RenderOptions): string;
export function createClassifier(customRules?: Rule[], opts?: { replaceDefaults?: boolean }): Classifier;
export function readableTime(ms: number, withSeconds?: boolean): string;

export const history: {
  createClassifier: typeof createClassifier;
  collectFailures(tree: Node[], classify?: Classifier): Failure[];
  collectFlaky(tree: Node[]): FlakyStep[];
  historyFile(dir: string, name: string): string;
  load(file: string): unknown[];
  record(file: string, run: { startTime: number; duration: number; tree: Node[]; labels?: Record<string, string>; classify?: Classifier; maxRuns?: number; redact?: boolean | RedactOptions | Redactor; shards?: number }): unknown[];
  collectOutcomes(tree: Node[]): Record<string, "P" | "F" | "R" | "W" | "S">;
  flakySteps(runs: unknown[]): Array<{ step: string; testCase: string; failedRuns: number; retriedRuns: number; flips: number; flaky: boolean; consistent: boolean; outcomes: Array<'P' | 'F' | 'R' | '-'>; notRun: number; key: string }>;
  [key: string]: unknown;
};

export const runInfo: {
  git(cwd?: string): Record<string, string>;
  ci(env?: Record<string, string | undefined>): Record<string, string>;
  host(): Record<string, string>;
  android(opts?: { udid?: string; appPackage?: string }): Record<string, string>;
};

export const attachments: {
  fromContent(name: string, content: string | Buffer | object, opts?: { contentType?: string }): Attachment | null;
  fromFile(name: string, filePath: string, opts?: FileAttachOptions): Attachment;
  DEFAULT_MAX_EMBED: number;
};
