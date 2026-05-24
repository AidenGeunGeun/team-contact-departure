import { runContactCli } from "../src/cli/contact.js";

const exitCode = await runContactCli(process.argv);
process.exit(exitCode);
