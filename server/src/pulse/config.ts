/**
 * Pulse config (Doc 16 G1): env first, settings rows override when present.
 * Settings keys mirror the env names in lowercase.
 */
import type { TrendPulseConfig } from "../config/env.js";

export interface PulseConfig {
  enabled: boolean;
  intervalMin: number;
  topN: number;
  maxRequests: number;
  retentionDays: number;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

export function resolvePulseConfig(config: TrendPulseConfig, settings: Map<string, unknown>): PulseConfig {
  return {
    enabled: boolOr(settings.get("pulse_enabled"), config.pulseEnabled),
    intervalMin: intOr(settings.get("pulse_interval_min"), config.pulseIntervalMin, 5, 60),
    topN: intOr(settings.get("pulse_top_n"), config.pulseTopN, 1, 10),
    maxRequests: intOr(settings.get("pulse_max_requests"), config.pulseMaxRequests, 1, 1000),
    retentionDays: intOr(settings.get("pulse_retention_days"), config.pulseRetentionDays, 1, 365),
  };
}
