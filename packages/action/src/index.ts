import * as core from "@actions/core";
import { readConfig } from "./inputs.ts";
import { run } from "./run.ts";

try {
  const config = readConfig((name) => {
    const value = core.getInput(name);
    if (value && ["github-token", "gitlab-token", "gitlab-sources", "wakatime-api-key"].includes(name)) core.setSecret(value);
    return value;
  });
  for (const token of [config.githubToken, config.gitlabToken, config.wakatime.apiKey, ...(config.gitlabSources ?? []).map((source) => source.token)]) {
    if (token) core.setSecret(token);
  }
  const result = await run(config, {
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    logger: { info: core.info, warning: core.warning },
  });
  core.setOutput("files", result.files.join("\n"));
  core.setOutput("committed", String(result.committed));
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
