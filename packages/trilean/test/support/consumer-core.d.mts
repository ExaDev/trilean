export const MAX_NESTING_DEPTH: number;
export const MAX_ARRAY_LENGTH: number;
export function run(
  trilean: object,
  cases: readonly unknown[],
): { executed: number; failures: string[] };
