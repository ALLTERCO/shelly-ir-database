// A no-op stand-in for the web interface's debug logging. The parsers import
// it; a build script has nothing to log it to.
import type { ir_record_t } from './types';

export function setIrDebug(_on: boolean): void {}

export function isIrDebug(): boolean {
  return false;
}

export function irLog(..._args: unknown[]): void {}

export function describeRecord(_record: ir_record_t): Record<string, unknown> {
  return {};
}

export function logRecords(_title: string, _records: ir_record_t[]): void {}
