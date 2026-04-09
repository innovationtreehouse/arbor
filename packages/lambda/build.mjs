import { build } from "esbuild";
import { execSync } from "child_process";

const sha = execSync("git rev-parse --short HEAD").toString().trim();
// Use the commit timestamp (not wall clock) so the bundle is reproducible:
// the same git SHA always produces the same zip, keeping the SSM digest check valid.
const buildTime = execSync("git log -1 --format=%cI HEAD").toString().trim();

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
