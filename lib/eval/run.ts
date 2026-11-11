import { formatReport, runSuite } from "./harness.js";
import { DEFAULT_SCENARIOS } from "./scenarios.js";

const report = await runSuite(DEFAULT_SCENARIOS);
console.log(formatReport(report));
// Not process.exit(): it can cut off buffered stdout before the report flushes.
process.exitCode = report.passed ? 0 : 1;
