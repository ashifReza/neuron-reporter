import type { Rule } from './index';

declare namespace NeuronPlaywrightReporter {
  interface Options extends NeuronPlaywrightReporterOptions {}
}

interface NeuronPlaywrightReporterOptions {
  /** Default 'neuron-report/index.html' */
  outputFile?: string;
  /** Also write the run as JSON here (automatic under --shard, for neuron-reporter merge) */
  jsonFile?: string;
  /** Secret redaction, on by default */
  redact?: boolean | import("./index").RedactOptions;
  title?: string;
  history?: boolean | { dir?: string; maxRuns?: number };
  /** Default ['test.step', 'expect', 'pw:api'] */
  stepCategories?: string[];
  /** How to include video/trace files: 'auto' (default) embeds up to maxEmbedBytes and links bigger ones */
  embed?: boolean | 'auto';
  maxEmbedBytes?: number;
  rules?: Rule[];
  labels?: Record<string, string>;
}

declare class NeuronPlaywrightReporter {
  constructor(options?: NeuronPlaywrightReporterOptions);
  printsToStdio(): boolean;
  onBegin(config: unknown, suite: unknown): void;
  onTestEnd(test: unknown, result: unknown): void;
  onEnd(result?: unknown): void;
}

export = NeuronPlaywrightReporter;
