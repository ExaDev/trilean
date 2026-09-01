# Security

## Supported versions

trilean has no maintenance-branch strategy — releases publish continuously off `main` via semantic-release. Only the latest version on npm receives fixes; there is no backport to an older major/minor.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the [Security tab](https://github.com/ExaDev/trilean/security) and select "Report a vulnerability". Do not open a public issue for a suspected vulnerability.

## Scope

- **The validation boundary.** A `PredicateNode`/`ExpressionNode` tree may come from untrusted or semi-trusted authors — the README's own stated use case is a business rule edited via a UI by a non-developer. Zod schema validation is the parse boundary; a malformed tree that crashes the evaluator instead of producing a structured `wrong-type`/`domain-error` result is a real bug to report, since silently throwing instead of returning an indeterminate outcome violates the design's own three-outcome model (see [The evaluation model](README.md#the-evaluation-model)).
- **ReDoS in `textCompare`.** `matches`/`notMatches` compiles the right-hand operand as a live `RegExp` and runs it against the left-hand text (`compareText` in `src/evaluator.ts`), with no timeout or pattern-complexity guard. A consumer that lets untrusted authors write `textCompare` patterns *and* evaluates them against attacker-influenced strings has a genuine catastrophic-backtracking denial-of-service surface. This is a known, documented limitation rather than a bug to report on its own — but architecture-level questions about it are welcome.
- **No code execution from data.** A `call` node's `fn` is a string key resolved only against the function registry the consumer explicitly supplies at `createEvaluator` construction time (see [`call`](README.md#call)) — it is never evaluated as code. A malicious tree alone cannot achieve code execution through this package; report anything that appears to violate that boundary.
- **Supply chain.** Releases publish to npm via OIDC trusted publishing with Sigstore build provenance and an SPDX SBOM attached (see `.github/workflows/ci.yml`) — report anything suggesting a published artifact doesn't match its attested source. On the input side, `pnpm-workspace.yaml`'s `minimumReleaseAge` blocks installing any third-party dependency less than 60 minutes after its own publish, closing the window a compromised-maintainer-account attack is typically caught and pulled in.
