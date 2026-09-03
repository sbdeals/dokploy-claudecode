#!/usr/bin/env node
import { Command } from "commander";

import { claudeCommand } from "./commands/claude.js";
import { configCommand } from "./commands/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { downCommand } from "./commands/down.js";
import { localIngressCommand } from "./commands/local-ingress.js";
import { logsCommand } from "./commands/logs.js";
import { openCommand } from "./commands/open.js";
import { statusCommand } from "./commands/status.js";
import { upCommand } from "./commands/up.js";
import { UserError } from "./core/errors.js";
import { pc } from "./core/prompts.js";
import { parsePort } from "./core/util.js";
import { CLI_VERSION } from "./version.js";

const program = new Command();

program
  .name("switchyard")
  .description(
    "One-command install & management for the Dokploy + Switchyard stack.\n" +
      "Stands up Dokploy, registers the admin, and runs the Switchyard dashboard as a managed container.",
  )
  .version(CLI_VERSION);

program
  .command("up")
  .description("Install/converge the whole stack (idempotent — also upgrades)")
  .option("--dokploy-port <port>", "host port for Dokploy (default 3000; adopted from an existing install)", parsePort)
  .option("--dashboard-port <port>", "host port for the Switchyard dashboard (default 3001)", parsePort)
  .option("--expose", "publish the dashboard on all interfaces (login required, but no TLS; requires confirmation)")
  .option("--skip-traefik", "don't run the Traefik proxy (domains won't route)")
  .option("--tag <tag>", "Switchyard image tag (default: the CLI version)")
  .option("--email <email>", "Dokploy admin email")
  .option("--password <password>", "Dokploy admin password")
  .option("--admin-name <name>", "Dokploy admin display name (default Admin)")
  .option("--headless", "never prompt; auto-generate missing credentials (implies --no-claude)")
  .option("--no-claude", "skip the Claude Code install/launch step")
  .option("--force", "install even when leftover Dokploy data volumes exist (FORCE=1)")
  .option("--yes", "assume yes for confirmations (e.g. --expose)")
  .action(upCommand);

program.command("status").description("Show stack status, container health, and URLs").action(statusCommand);

program
  .command("down")
  .description("Stop the stack; --purge also deletes network, secrets, and data volumes")
  .option("--purge", "delete network, secrets, and data volumes (fresh slate)")
  .option("--yes", "skip the confirmation prompt")
  .action(downCommand);

program
  .command("config")
  .description("Read or change persisted settings (set recreates the container)")
  .argument("<action>", "list | get | set")
  .argument("[key]")
  .argument("[value]")
  .option("--no-restart", "save only; don't recreate the container")
  .option("--show-secrets", "print secret values in list/set output")
  .action(configCommand);

program
  .command("local-ingress")
  .description("Opt-in demo Traefik on alternate ports (Docker Desktop; HTTP-only, NOT real TLS)")
  .argument("<action>", "up | down")
  .action(localIngressCommand);

program.command("doctor").description("Check prerequisites and stack health (read-only)").action(doctorCommand);

program
  .command("logs")
  .description("Tail logs: switchyard (container) or dokploy (service)")
  .argument("[target]", "switchyard | dokploy", "switchyard")
  .option("-f, --follow", "follow log output")
  .action(logsCommand);

program.command("open").description("Open the dashboard in your browser").action(openCommand);

program
  .command("claude")
  .description("Launch Claude Code here (installs the CLI first if needed)")
  .argument("[args...]", "arguments passed through to claude")
  .action((args: string[]) => claudeCommand(args ?? []));

program.parseAsync().catch((err: unknown) => {
  if (err instanceof UserError) {
    console.error(`\n${pc.red("✗")} ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
