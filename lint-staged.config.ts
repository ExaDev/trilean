import { relative, sep } from "node:path";
import type { Configuration } from "lint-staged";

// ESLint's flat config resolves from the working directory, not from each linted file's own directory, so running `eslint --fix` at the workspace root over staged files in packages/<name>/ would apply the root config -- which ignores packages/** -- and report every one of them as ignored rather than linting it. Each package owns its own eslint.config.ts, so the fix has to run once per package, in that package's directory. Files outside packages/ are linted by the root config in one final invocation.

const PACKAGES_DIR = "packages";

// packages / <package name> / <at least one path segment inside it>. A path with fewer segments than that names the packages directory itself or a package's own root entry, neither of which is a file inside a package.
const SEGMENTS_IN_SHALLOWEST_PACKAGE_FILE_PATH = 3;

function packageDirectoryOf(repoRelativePath: string): string | undefined {
  const segments = repoRelativePath.split(sep);
  const [first, second] = segments;
  if (
    first !== PACKAGES_DIR ||
    second === undefined ||
    segments.length < SEGMENTS_IN_SHALLOWEST_PACKAGE_FILE_PATH
  ) {
    return undefined;
  }
  return `${PACKAGES_DIR}${sep}${second}`;
}

function groupByDirectory(
  absolutePaths: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const absolutePath of absolutePaths) {
    const repoRelativePath = relative(process.cwd(), absolutePath);
    const directory = packageDirectoryOf(repoRelativePath) ?? ".";
    const existing = grouped.get(directory);
    if (existing === undefined) {
      grouped.set(directory, [repoRelativePath]);
    } else {
      existing.push(repoRelativePath);
    }
  }
  return grouped;
}

const config: Configuration = {
  "*.ts": (files) =>
    [...groupByDirectory(files)].map(([directory, paths]) => {
      const pathsRelativeToDirectory = paths.map(
        (path) => `"${directory === "." ? path : relative(directory, path)}"`,
      );
      return `pnpm --dir ${directory} exec eslint --fix ${pathsRelativeToDirectory.join(" ")}`;
    }),
};

export default config;
