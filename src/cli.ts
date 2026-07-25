import {
  jobDetectFbPages,
  jobLogin,
  jobSend,
  jobSyncBlacklist,
  jobSyncContacts,
  jobSyncPages,
} from "./jobs.js";

function printHelp(): void {
  console.log(`
Facebook 公共主页网页群发

推荐:
  npm run ui

命令行:
  npm run login
  npm run sync:pages
  npm run detect:fb
  npm run sync:blacklist
  npm run sync:contacts
  npm run send:dry
  npm run send
`);
}

function getArg(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const log = (line: string) => console.log(line);

  switch (command) {
    case "login":
      await jobLogin(log);
      break;
    case "sync-pages":
      await jobSyncPages(log);
      break;
    case "detect-fb-pages":
      await jobDetectFbPages(log);
      break;
    case "sync-blacklist":
      await jobSyncBlacklist(log);
      break;
    case "sync-contacts": {
      if (getArg(rest, "--days")) {
        const { saveSettings } = await import("./settings.js");
        const { config } = await import("./config.js");
        await saveSettings(config.rootDir, {
          contactDays: Number(getArg(rest, "--days")),
        });
      }
      await jobSyncContacts(log);
      break;
    }
    case "send":
      await jobSend(
        {
          dryRun: rest.includes("--dry-run"),
          pageIds: (getArg(rest, "--pages") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        log,
      );
      break;
    case "help":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`未知命令: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
