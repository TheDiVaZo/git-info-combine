import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateManualContribution, type ManualContributionDocument } from "@git-info-combine/core";
import { parseExportConfig } from "./config.ts";
import { scanRepository } from "./git.ts";
import { ExportError } from "./errors.ts";

export interface ExportSourceSummary {
  id: string;
  name: string;
  repositories: number;
  commits: number;
  firstDate: string | null;
  lastDate: string | null;
  file: string;
  changed: boolean;
}

export interface ExportSummary {
  sources: ExportSourceSummary[];
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new ExportError();
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new ExportError("An output file is not a readable regular file.");
  }
}

/** Reads local Git history only. The returned summary contains no repository metadata. */
export async function exportLocal(configPath: string, outputDir: string): Promise<ExportSummary> {
  let raw: unknown;
  try {
    raw = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw new ExportError("Cannot read the local export configuration as JSON.");
  }
  const config = parseExportConfig(raw, resolve(configPath));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" });
  const documents: ManualContributionDocument[] = [];
  const summary: ExportSummary = { sources: [] };
  for (const source of config.sources) {
    const seen = new Set<string>();
    const days: Record<string, number> = {};
    for (const repository of source.repositories) {
      await scanRepository(repository, (sha, timestamp) => {
        if (seen.has(sha)) return;
        seen.add(sha);
        const parts = formatter.formatToParts(new Date(timestamp * 1000));
        const part = (kind: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === kind)!.value;
        const day = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
        days[day] = (days[day] ?? 0) + 1;
      });
    }
    const sortedDays = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const document = validateManualContribution({
      schemaVersion: 1,
      source: { id: source.id, name: source.name, type: "manual", metric: "commits", ...(source.color ? { color: source.color } : {}) },
      timezone: config.timezone,
      days: sortedDays,
    });
    documents.push(document);
    const dates = Object.keys(sortedDays);
    summary.sources.push({ id: source.id, name: source.name, repositories: source.repositories.length, commits: seen.size, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null, file: `${source.id}.json`, changed: false });
  }

  // Every history and destination is checked before publishing any result.
  const output = resolve(outputDir);
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ExportError();
  } catch (error) {
    if (!isMissing(error)) throw new ExportError("The output directory is not an accessible regular directory.");
  }
  const writes: { target: string; temporary: string; content: string }[] = [];
  for (const [index, document] of documents.entries()) {
    const item = summary.sources[index]!;
    const target = join(output, item.file);
    const content = `${JSON.stringify(document, null, 2)}\n`;
    const previous = await existingFile(target);
    if (previous !== undefined) {
      try {
        const existing = validateManualContribution(JSON.parse(previous));
        if (existing.source.id !== document.source.id) throw new ExportError();
      } catch {
        throw new ExportError("An output filename is occupied by a different or invalid manual source; it was not overwritten.");
      }
    }
    if (previous === content) continue;
    item.changed = true;
    writes.push({ target, temporary: join(output, `.${item.file}.${randomUUID()}.tmp`), content });
  }
  if (!writes.length) return summary;
  const temporaryFiles: string[] = [];
  try {
    await mkdir(output, { recursive: true });
    for (const write of writes) {
      const file = await open(write.temporary, "wx");
      temporaryFiles.push(write.temporary);
      try {
        await file.writeFile(write.content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    }
    for (const write of writes) await rename(write.temporary, write.target);
  } catch {
    throw new ExportError("Could not publish the contribution files. Check output access; no commit was created.");
  } finally {
    for (const temporary of temporaryFiles) await unlink(temporary).catch(() => {});
  }
  return summary;
}
