// Pyodide/Emscripten probes process.env during startup, which triggers
// Deno's --allow-env permission prompt. Stub it out with an empty object
// so the sandbox can boot without extra permissions.
import process from "node:process";
Object.defineProperty(process, "env", { get: () => ({}) });
