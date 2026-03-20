const { execSync } = require("child_process");
const path = require("path");

const tenjoDir = path.join(__dirname, "..", "tenjo");
const tenjoDesktopDir = path.join(__dirname, "..");

execSync("npm ci", { cwd: tenjoDir, stdio: "inherit" });
execSync("npm run license-report", { cwd: tenjoDir, stdio: "inherit" });
execSync("npm run build", { cwd: tenjoDir, stdio: "inherit" });
execSync("npm prune --omit=dev", { cwd: tenjoDir, stdio: "inherit" });

execSync("npm run license-report", { cwd: tenjoDesktopDir, stdio: "inherit" });
