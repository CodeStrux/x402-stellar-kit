import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

type Fence = Readonly<{ language: string; source: string; index: number }>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const fences = (markdown: string): Fence[] => {
  const found: Fence[] = [];
  const pattern = /```(ts|typescript|js|javascript)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    found.push({
      language: match[1],
      source: match[2],
      index: found.length + 1,
    });
  }
  return found;
};

const formatDiagnostics = (diagnostics: readonly ts.Diagnostic[]): string =>
  diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (diagnostic.file === undefined || diagnostic.start === undefined) {
        return message;
      }
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
    })
    .join("\n");

const checkFence = async (
  documentName: string,
  fence: Fence,
): Promise<readonly ts.Diagnostic[]> => {
  const directory = await mkdtemp(join(tmpdir(), "x402-docs-"));
  temporaryDirectories.push(directory);
  const isJavaScript = fence.language === "js" || fence.language === "javascript";
  const file = join(directory, `fence-${fence.index}.${isJavaScript ? "mjs" : "mts"}`);
  await writeFile(file, fence.source, "utf8");
  const root = process.cwd();
  const program = ts.createProgram([file], {
    allowJs: isJavaScript,
    baseUrl: root,
    checkJs: isJavaScript,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    paths: {
      "hono": [join(root, "node_modules/hono/dist/types/index.d.ts")],
      // A real runtime dependency of this package, so documentation is allowed to
      // reference it — a reader importing Keypair is doing the ordinary thing.
      "@stellar/stellar-base": [
        join(root, "node_modules/@stellar/stellar-base/types/index.d.ts"),
      ],
      "x402-stellar-kit": [join(root, "src/index.ts")],
      "x402-stellar-kit/server/hono": [
        join(root, "src/server/adapters/hono.ts"),
      ],
      "x402-stellar-kit/server/express": [
        join(root, "src/server/adapters/express.ts"),
      ],
      "x402-stellar-kit/server/next": [
        join(root, "src/server/adapters/next.ts"),
      ],
      "x402-stellar-kit/mcp": [join(root, "mcp/server.ts")],
    },
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: ["node"],
  });
  const sourceFile = program.getSourceFile(file);
  if (sourceFile === undefined) {
    throw new Error(`TypeScript did not load ${documentName} fence ${fence.index}`);
  }
  return [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
};

describe("documentation code promises", () => {
  for (const documentName of ["README.md", "AGENTS.md"]) {
    it(`type-checks every TypeScript and JavaScript fence in ${documentName}`, async () => {
      const markdown = await readFile(new URL(`../${documentName}`, import.meta.url), "utf8");
      const blocks = fences(markdown);
      expect(blocks.length, `${documentName} must contain checked code`).toBeGreaterThan(0);
      for (const block of blocks) {
        const diagnostics = await checkFence(documentName, block);
        expect(
          diagnostics,
          `${documentName} fence ${block.index}\n${formatDiagnostics(diagnostics)}`,
        ).toEqual([]);
      }
    });
  }
});
