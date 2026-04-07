/**
 * ArkTS service layer — imports and calls utils.ets.
 */
import { greet, formatName } from './utils';

export function createGreeting(name: string): string {
  return greet(name);
}

export function normalizeAndGreet(rawName: string): string {
  const cleaned = formatName(rawName);
  return createGreeting(cleaned);
}
