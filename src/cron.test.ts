// Run: node src/cron.test.ts
import assert from "node:assert/strict";
import { cdLine, parseCrontab, serializeCrontab, validSched } from "./cron.ts";

const src = "# m h  dom mon dow   command\nMAILTO=me\n*/5 * * * * /bin/backup.sh --x\n#  0 3 * * mon echo off\n@reboot  run.sh\n";
const l = parseCrontab(src);
assert.equal(l.length, 5);
assert.equal(l[0].job, false); // header comment stays a comment
assert.equal(l[1].job, false);
assert.deepEqual(l[2], { job: true, on: true, sched: "*/5 * * * *", cmd: "/bin/backup.sh --x" });
assert.deepEqual(l[3], { job: true, on: false, sched: "0 3 * * mon", cmd: "echo off" });
assert.deepEqual(l[4], { job: true, on: true, sched: "@reboot", cmd: "run.sh" });
assert.equal(serializeCrontab(parseCrontab(serializeCrontab(l))), serializeCrontab(l)); // stable round trip
assert.deepEqual(parseCrontab(""), []);
assert.ok(validSched("0 3 * * *") && validSched("@daily"));
assert.ok(!validSched("0 3 * *") && !validSched("@sometimes") && !validSched(""));
assert.equal(cdLine("/opt/app/backup.sh --x"), `cd -- '/opt/app/backup.sh' 2>/dev/null || cd -- "$(dirname -- '/opt/app/backup.sh')"`);
assert.ok(cdLine("cd ~/site && npm run build >> /var/log/b.log").startsWith(`cd -- "$HOME"'/site'`));
assert.equal(cdLine("echo hi"), "");
console.log("cron ok");
