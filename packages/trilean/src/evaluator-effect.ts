/**
 * The evaluator's node rules are written once, as generator functions that describe *what* to wait for rather than *how* to wait for it. `evaluator.ts` `yield*`s two kinds of suspension and never touches a promise itself:
 * - `wait`: a single resolver result that is either already a value or a promise of one.
 * - `all`: sub-evaluations that are independent of one another, which the async driver runs concurrently and the synchronous driver runs one after another.
 * Two drivers then run the same generator: `runAsync` awaits every suspension, `runSync` requires every one to already be a value. Because both drive one implementation of the node rules, the synchronous and asynchronous evaluators cannot drift apart in how a node is evaluated.
 */

/** A single value that may still be a promise; `wait` resolves it in whichever driver runs the surrounding task. */
type Awaitable<T> = T | Promise<T>;

/** What a task suspends on: one resolver result (`wait`) or independent sub-tasks (`all`). */
export type Suspension =
  | { readonly kind: "wait"; readonly value: unknown }
  | { readonly kind: "all"; readonly tasks: readonly Runnable<unknown>[] };

/** A suspendable computation: yields `Suspension`s and returns `T`. Its "next" type is `never` so that only a `yield*` of `wait` or `all` (whose results are typed by their own operands) can sit inside one; a driver resumes it through `Runnable`, which is deliberately looser. */
export type Task<T> = Generator<Suspension, T, never>;

/** What a driver needs from a task: resume it with whatever the last suspension produced. Generator methods are bivariant, so every `Task` is a `Runnable`. */
type Runnable<T> = Iterator<Suspension, T, unknown>;

type TaskResults<T extends readonly Runnable<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Task<infer R> ? R : never;
};

/**
 * Suspends until `value` is available. The driver resumes the task with exactly that value (awaited, in the async driver), and the generator's own "next" type is `T`, so the result is typed without an assertion.
 */
export function* wait<T>(value: Awaitable<T>): Generator<Suspension, T, T> {
  return yield { kind: "wait", value };
}

/**
 * Suspends until every task has finished and returns their results in order. The tasks are independent of one another by construction, so a driver may interleave them (async) or run them in sequence (sync).
 */
export function* all<const T extends readonly Runnable<unknown>[]>(
  tasks: T,
): Generator<Suspension, TaskResults<T>, TaskResults<T>> {
  return yield { kind: "all", tasks };
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Runs a task to completion, awaiting each suspension and running an `all` group's tasks concurrently. */
export async function runAsync<T>(task: Readonly<Runnable<T>>): Promise<T> {
  let step = task.next();
  while (step.done !== true) {
    const suspension = step.value;
    const result =
      suspension.kind === "wait"
        ? await suspension.value
        : await Promise.all(suspension.tasks.map(runAsync));
    step = task.next(result);
  }
  return step.value;
}

/**
 * Runs a task to completion without awaiting anything: an `all` group's tasks run one after another, and a `wait` on a promise throws, since a synchronous evaluator has nothing to do with one.
 */
export function runSync<T>(task: Readonly<Runnable<T>>): T {
  let step = task.next();
  while (step.done !== true) {
    const suspension = step.value;
    let result: unknown;
    if (suspension.kind === "wait") {
      if (isThenable(suspension.value)) {
        throw new TypeError(
          "a resolver supplied to a synchronous evaluator returned a promise; use the asynchronous evaluator for asynchronous resolvers",
        );
      }
      result = suspension.value;
    } else {
      result = suspension.tasks.map(runSync);
    }
    step = task.next(result);
  }
  return step.value;
}
