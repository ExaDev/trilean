export type { TrileanConstraintOptions } from "./constraint";
export { trileanConstraint } from "./constraint";

export type { CoveringArrayOptions } from "./covering";
export { coveringArray } from "./covering";

export type { CoveringCheckOptions } from "./verify";
export { isCoveringArray } from "./verify";

export {
  EvaluationBudgetError,
  PredicateTreeError,
  UndecidedConstraintError,
  UnmappableValueError,
} from "./errors";
