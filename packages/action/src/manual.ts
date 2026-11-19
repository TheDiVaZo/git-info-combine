import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { parseManualContribution, type ManualContributionDocument } from "@git-info-combine/core";

function isOutside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part);
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Local aggregates only: no Git access and no filesystem paths enter public data. */
export async function loadManualContributions(workspace: string, directory?: string): Promise<ManualContributionDocument[]> {
  if (!directory) return [];
  if (isAbsolute(directory) || win32.isAbsolute(directory) || /^[A-Za-z]:/.test(directory)) {
    throw new Error("Input manual-contributions-dir must be relative to the workspace.");
  }
  let root: string;
  try {
    root = await realpath(workspace);
  } catch {
    throw new Error("Cannot access the workspace for manual contributions.");
  }
  const target = resolve(root, directory.replace(/[\\/]/g, sep));
  if (isOutside(root, target)) throw new Error("Input manual-contributions-dir must stay inside the workspace.");
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (missing(error)) return [];
      throw new Error("Cannot read the manual contributions directory.");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("The manual contributions directory must contain only real directory components.");
    }
  }
  let files: string[];
  try {
    if (isOutside(root, await realpath(target))) throw new Error();
    files = (await readdir(target)).filter((name) => name.toLowerCase().endsWith(".json")).sort();
  } catch {
    throw new Error("Cannot read the manual contributions directory.");
  }
  const documents: ManualContributionDocument[] = [];
  const ids = new Set<string>();
  for (const [index, file] of files.entries()) {
    let document: ManualContributionDocument;
    try {
      const path = join(target, file);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || isOutside(target, await realpath(path))) throw new Error();
      document = parseManualContribution(await readFile(path, "utf8"));
    } catch {
      throw new Error(`Manual contribution file ${index + 1} could not be read or has an invalid schema.`);
    }
    if (ids.has(document.source.id)) throw new Error("Manual contribution files contain duplicate source identifiers.");
    ids.add(document.source.id);
    documents.push(document);
  }
  return documents;
}
