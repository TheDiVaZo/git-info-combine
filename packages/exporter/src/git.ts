import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { authorEmails, type ExportRepository } from "./config.ts";
import { ExportError } from "./errors.ts";

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[key];
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1" };
}

function git(path: string, args: string[]) {
  const child = spawn("git", ["--no-pager", "--no-optional-locks", "-C", path, ...args], {
    env: environment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.setEncoding("utf8");
  const completed = new Promise<number>((done) => {
    child.once("error", () => done(-1));
    child.once("close", (code) => done(code ?? -1));
  });
  return { child, completed };
}

async function read(path: string, args: string[]): Promise<{ code: number; text: string }> {
  const { child, completed } = git(path, args);
  let result = "";
  for await (const chunk of child.stdout) {
    result += chunk;
    if (result.length > 1_048_576) {
      child.kill();
      await completed;
      throw new ExportError("Git metadata exceeded the expected size.");
    }
  }
  return { code: await completed, text: result.trim() };
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}

export async function scanRepository(
  repository: ExportRepository,
  receive: (sha: string, timestamp: number) => void,
): Promise<void> {
  const label = `Repository ${repository.index}`;
  let path: string;
  try {
    if (!(await stat(repository.path)).isDirectory()) throw new ExportError();
    path = await realpath(repository.path);
  } catch {
    throw new ExportError(`${label} is not an accessible directory.`);
  }

  try {
    const root = await read(path, ["rev-parse", "--show-toplevel"]);
    if (root.code !== 0 || !samePath(path, await realpath(root.text))) throw new ExportError();
  } catch {
    throw new ExportError(`${label} must identify the root of an accessible Git worktree.`);
  }
  const shallow = await read(path, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.code !== 0 || shallow.text !== "false") throw new ExportError(`${label} has shallow or unavailable history; export requires complete local history.`);
  let emails = repository.emails;
  if (!emails) {
    const configured = await read(path, ["config", "--get", "user.email"]);
    if (configured.code !== 0 || !configured.text) throw new ExportError(`${label} has no author email; configure author-emails or Git user.email.`);
    emails = authorEmails([configured.text], `${label} author email`);
  }
  const wanted = new Set(emails);
  const head = await read(path, ["rev-parse", "--verify", "HEAD"]);
  const args = ["log", "-z", "--no-use-mailmap", "--no-show-signature", "--no-notes", "--format=%H%x00%ae%x00%ct", "--branches", "--remotes"];
  if (head.code === 0) args.push("HEAD");
  args.push("--");

  const { child, completed } = git(path, args);
  let pending = "";
  const fields: string[] = [];
  const accept = (field: string) => {
    fields.push(field);
    if (fields.length !== 3) return;
    const [sha, email, rawTimestamp] = fields;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha!) || !/^-?\d+$/.test(rawTimestamp!)) throw new ExportError();
    const timestamp = Number(rawTimestamp);
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp * 1000).getTime())) throw new ExportError();
    if (wanted.has(email!)) receive(sha!, timestamp);
    fields.length = 0;
  };
  try {
    for await (const chunk of child.stdout) {
      pending += chunk;
      let start = 0;
      let end: number;
      while ((end = pending.indexOf("\0", start)) !== -1) {
        accept(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
      if (pending.length > 65_536) throw new ExportError();
    }
    if (pending) accept(pending);
    if (await completed !== 0 || fields.length) throw new ExportError();
  } catch {
    child.kill();
    await completed;
    throw new ExportError(`${label} history could not be read completely. No contribution files were updated.`);
  }
}
