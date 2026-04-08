import { build } from "esbuild";
import { execSync } from "child_process";

const sha = execSync("git rev-parse --short HEAD").toString().trim();
const buildTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

await build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: "dist/index.bundle.js",
  external: ["@aws-sdk/*"],
  define: {
    __GIT_SHA__: JSON.stringify(sha),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
});

console.log(`Bundle: dist/index.bundle.js (sha=${sha}, built=${buildTime})`);
