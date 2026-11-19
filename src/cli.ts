/**
 *   tsx src/cli.ts serve          webhooks + booking page + dashboard on PORT
 *   tsx src/cli.ts tick           run due follow-ups once (cron: every 5 minutes)
 *   tsx src/cli.ts dlq            CRM syncs waiting for replay
 *   tsx src/cli.ts replay <id|all>
 */
import { buildEngine, createHttpServer } from "./app.js";
import { loadConfig } from "./config.js";
import { configureLogger, log } from "./logger.js";

const cfg = loadConfig();
configureLogger({ format: cfg.LOG_FORMAT });
const { engine } = buildEngine(cfg);
const [cmd, arg] = process.argv.slice(2);

if (cmd === "serve") {
  const server = createHttpServer(engine);
  server.listen(cfg.PORT, () => log.info("listening", { url: cfg.PUBLIC_URL, crm: engine.crm.name, crmMock: cfg.CRM_MOCK }));
  if (process.env.TICK_EVERY_MS) setInterval(() => engine.tick().catch((e) => log.error("tick failed", { error: String(e) })), Number(process.env.TICK_EVERY_MS));
} else if (cmd === "tick") {
  console.log(await engine.tick());
} else if (cmd === "dlq") {
  const items = engine.store.deadLetters();
  console.log(items.length ? items : "CRM dead-letter queue is empty.");
} else if (cmd === "replay") {
  const ids = arg === "all" ? engine.store.deadLetters().map((d) => d.id) : [Number(arg)];
  for (const id of ids) console.log(`replay #${id}:`, (await engine.replayDeadLetter(id)) ? "ok" : "still failing");
} else {
  console.log("usage: tsx src/cli.ts serve|tick|dlq|replay <id|all>");
}
