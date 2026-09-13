import { openDatabase } from "./server/storage/db.mjs";
import { installKnowledgeFixture, currentServingVersion, currentSnapshotCte, effectiveCountsOf } from "./server/services/knowledge-store.mjs";
import { createJob, createJobRunner } from "./server/services/knowledge-jobs.mjs";
import { readMetrics } from "./server/services/knowledge-query.mjs";

const S = "demo-01";
const db = openDatabase(":memory:");
installKnowledgeFixture(db, { sessionId: S });
const runner = createJobRunner({ db, sessionId: S, logger: { error: console.error } });
console.log("baseline", JSON.stringify(readMetrics(db, S).metrics));
const j = createJob(db, { sessionId: S, actorId: "shi", scope: "backlog" });
const r = runner.runToEnd(j.job.id);
console.log("after job", JSON.stringify(r), JSON.stringify(readMetrics(db, S).metrics));
console.log("effective", JSON.stringify(effectiveCountsOf(db, S, currentServingVersion(db, S))));
const serving = currentServingVersion(db, S);
console.log("snapshot breakdown", JSON.stringify(db.prepare(`${currentSnapshotCte(S, serving)} SELECT take, COUNT(*) AS n FROM snapshot GROUP BY take`).all()));
runner.stopAll();
db.close();
