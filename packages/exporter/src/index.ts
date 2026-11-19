import { exportLocal } from "./export.ts";
import { ExportError } from "./errors.ts";

try {
  let config: string | undefined;
  let output: string | undefined;
  let json = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json-summary") { json = true; continue; }
    if (arg === "--help") {
      console.log("Usage: export:local --config <file> --output-dir <directory> [--json-summary]");
      process.exit(0);
    }
    if (arg !== "--config" && arg !== "--output-dir") throw new ExportError("Unsupported exporter argument. Use --help for usage.");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new ExportError("Exporter arguments require a configuration file and output directory.");
    if (arg === "--config") {
      if (config !== undefined) throw new ExportError("The configuration argument was specified more than once.");
      config = value;
    } else {
      if (output !== undefined) throw new ExportError("The output argument was specified more than once.");
      output = value;
    }
  }
  if (!config || !output) throw new ExportError("Specify --config and --output-dir. Use --help for usage.");
  const result = await exportLocal(config, output);
  if (json) console.log(JSON.stringify(result));
  else {
    for (const source of result.sources) {
      console.log(`${source.name}: ${source.repositories} repositories, ${source.commits} commits, ${source.firstDate ?? "no activity"}${source.lastDate ? ` to ${source.lastDate}` : ""}; ${source.changed ? "updated" : "unchanged"} ${source.file}`);
    }
  }
} catch (error) {
  const message = error instanceof ExportError ? error.message : "The local export failed; no private diagnostic data was printed.";
  console.error(`Export failed: ${message}`);
  process.exitCode = 1;
}
