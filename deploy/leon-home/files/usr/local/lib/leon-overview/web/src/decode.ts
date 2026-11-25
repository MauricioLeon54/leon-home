/** Small, bounded JSON primitives; external values start as unknown. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid object');
  return value;
}
export function list(value: unknown, maximum: number): Array<unknown> {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('Invalid or oversized list');
  return value;
}
export function optionalList(value: unknown, maximum: number): Array<unknown> {
  return value === null || value === undefined ? [] : list(value, maximum);
}
export function string(value: unknown, maximum = 100): string {
  if (typeof value !== 'string') throw new Error('Invalid text');
  let count = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (++count > maximum || code < 32 || code === 127) throw new Error('Invalid text');
  }
  return value;
}
export function finite(value: unknown, minimum = 0, maximum = 100000): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}
export function timestamp(value: unknown, now: number): number | null {
  return finite(value, 1, now + 30);
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  const result = finite(value, minimum, maximum);
  if (result === null || !Number.isInteger(result)) throw new Error('Invalid integer');
  return result;
}
export function choice<T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T {
  return allowed.find(item => item === value) ?? fallback;
}
export function optionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error('Invalid boolean');
  return value;
}
export function address(value: unknown): string {
  const text = string(value, 15),
    parts = text.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) throw new Error('Invalid IPv4 address');
  return text;
}

// Strict parsers for view models: wrong types throw, null/undefined numbers stay null (unknown).
export function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error('Invalid number');
  return value;
}
export function nullableNumber(value: unknown, minimum: number, maximum: number): number | null {
  return value === null || value === undefined ? null : number(value, minimum, maximum);
}
export function boolean(value: unknown): boolean {
  const result = optionalBoolean(value);
  if (result === null) throw new Error('Missing boolean');
  return result;
}
export function oneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T {
  const found = allowed.find(item => item === value);
  if (found === undefined) throw new Error('Invalid choice');
  return found;
}
export function items<T>(value: unknown, maximum: number, parse: (item: unknown) => T): Array<T> {
  return list(value, maximum).map(parse);
}
export function nullable<T>(value: unknown, parse: (item: unknown) => T): T | null {
  return value === null || value === undefined ? null : parse(value);
}
