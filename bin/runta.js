#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then((code) => {
  // Exit once stdout is flushed; idle keep-alive sockets must not hold the process open.
  process.stdout.write("", () => process.exit(code));
});
