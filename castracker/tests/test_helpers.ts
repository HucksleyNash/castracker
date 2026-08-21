export function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals<T>(
  actual: T,
  expected: T,
  message = "Values are not equal",
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual:   ${actualJson}`,
    );
  }
}

export function assertThrows(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`Error did not match ${pattern}: ${message}`);
    }
    return;
  }
  throw new Error("Expected the action to throw.");
}
