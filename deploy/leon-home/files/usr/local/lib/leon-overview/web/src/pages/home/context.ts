import { type ReadingState } from '../../ui/reading.js';
import { reading } from '../../ui/reading.js';

/** What every Home section needs to word a reading: is the data old, and when was it taken. */
export interface HomeContext {
  isStale: boolean;
  observedAt: number | null;
}

type MetricTone = 'good' | 'warn' | undefined;

/** A reading from a nullable number: unknown stays an em dash; stale data is labelled "Earlier". */
export function metric(context: HomeContext, label: string, raw: number | null, format: (value: number) => string, tone?: MetricTone): HTMLElement {
  const state: ReadingState = context.isStale ? { kind: 'earlier', at: context.observedAt } : { kind: 'current', tone };
  return reading({ label, value: raw === null ? null : format(raw), state });
}

/** A reading whose text is already worded (Pi-hole percentages, power label). */
export function textMetric(context: HomeContext, label: string, value: string | null, tone?: MetricTone): HTMLElement {
  const state: ReadingState = context.isStale ? { kind: 'earlier', at: context.observedAt } : { kind: 'current', tone };
  return reading({ label, value, state });
}
