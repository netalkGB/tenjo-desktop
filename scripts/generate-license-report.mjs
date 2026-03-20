import * as checker from "license-checker-rseidelsohn";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const tenjoDir = path.join(rootDir, "tenjo");

const TENJO_WORKSPACES = ["client", "server", "chat-engine"];
const OUTPUT_PATH = path.join(tenjoDir, "client", "public", "license-report.txt");
const DUAL_LICENSE_PATH = path.join(__dirname, "dual-license-select.json");
const MANUAL_LICENSE_TEXTS_PATH = path.join(__dirname, "manual-license-texts.json");

// Also load tenjo's config files as fallback
const TENJO_DUAL_LICENSE_PATH = path.join(tenjoDir, "scripts", "dual-license-select.json");
const TENJO_MANUAL_LICENSE_TEXTS_PATH = path.join(tenjoDir, "scripts", "manual-license-texts.json");

/**
 * Load a JSON config file. Returns the default value if not found.
 */
async function loadJsonConfig(filePath, defaultValue = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

/**
 * Convert manual-license-texts.json array into a Map keyed by package name.
 */
function buildManualLicenseMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.package, entry.text);
  }
  return map;
}

/**
 * Extract GitHub owner/repo from a repository URL.
 */
function parseGitHubRepo(repoUrl) {
  if (!repoUrl) return null;

  const shorthandMatch = repoUrl.match(/^github:([^/]+)\/([^/#]+)/);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1], repo: shorthandMatch[2].replace(/\.git$/, "") };
  }

  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/#?]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

/**
 * Fetch the LICENSE file content from GitHub API.
 */
async function fetchLicenseFromGitHub(repoUrl) {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) return null;

  const { owner, repo } = parsed;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/license`;

  const headers = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "license-report-generator",
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(apiUrl, { headers });

  if (!res.ok) {
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        throw new Error("GitHub API rate limit exceeded");
      }
    }
    throw new Error(`GitHub API ${res.status} for ${owner}/${repo}`);
  }

  return res.text();
}

/**
 * Promisified wrapper around license-checker-rseidelsohn's init.
 */
function scanLicenses(dir) {
  return new Promise((resolve, reject) => {
    checker.init(
      {
        start: dir,
        excludePrivatePackages: true,
      },
      (err, packages) => {
        if (err) return reject(err);
        resolve(packages);
      },
    );
  });
}

/**
 * Use `npm ls` to get all transitive production dependency keys (name@version)
 * for a given workspace within the tenjo submodule.
 */
function getTenjoProductionDepKeys(workspace) {
  let result;
  try {
    result = execSync(`npm ls --omit=dev --all --json -w ${workspace}`, {
      cwd: tenjoDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    if (err.stdout) {
      result = err.stdout;
    } else {
      throw err;
    }
  }
  const tree = JSON.parse(result);
  const keys = new Set();

  function collect(obj) {
    if (!obj.dependencies) return;
    for (const [name, info] of Object.entries(obj.dependencies)) {
      if (info.version) {
        keys.add(`${name}@${info.version}`);
      }
      collect(info);
    }
  }

  collect(tree);
  return keys;
}

/**
 * Use `npm ls` to get all transitive production dependency keys (name@version)
 * for tenjo-desktop root.
 */
function getDesktopProductionDepKeys() {
  let result;
  try {
    result = execSync("npm ls --omit=dev --all --json", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    if (err.stdout) {
      result = err.stdout;
    } else {
      throw err;
    }
  }
  const tree = JSON.parse(result);
  const keys = new Set();

  function collect(obj) {
    if (!obj.dependencies) return;
    for (const [name, info] of Object.entries(obj.dependencies)) {
      if (info.version) {
        keys.add(`${name}@${info.version}`);
      }
      collect(info);
    }
  }

  collect(tree);
  return keys;
}

/**
 * Resolve the license text for a package.
 * Priority:
 *   1. Local LICENSE file in node_modules
 *   2. GitHub API (auto-fetch from repository URL)
 *   3. manual-license-texts.json
 */
async function resolveLicenseText(key, pkg, manualTexts) {
  const { licenses, licenseFile } = pkg;
  const pkgPath = pkg.path;
  const isDualLicensed = licenses && licenses.includes(" OR ");

  // 1. Try local LICENSE files first
  if (isDualLicensed && pkgPath) {
    try {
      const files = await fs.readdir(pkgPath);
      const localLicenseFiles = files.filter((f) => /LICENSE|LICENCE|COPYING/i.test(f));
      if (localLicenseFiles.length > 0) {
        let text = "";
        for (const lf of localLicenseFiles) {
          const data = await fs.readFile(path.join(pkgPath, lf), "utf8");
          text += `${data}\n`;
        }
        return text;
      }
    } catch {
      // fall through to other methods
    }
  } else if (licenseFile) {
    const fileName = path.basename(licenseFile);
    if (/LICENSE|LICENCE|COPYING/i.test(fileName)) {
      try {
        return await fs.readFile(licenseFile, "utf8");
      } catch {
        // fall through
      }
    }
  }

  // 2. Try GitHub API auto-fetch
  const repoUrl = pkg.repository;
  if (repoUrl) {
    try {
      console.log(`  Fetching license for ${key} from GitHub API...`);
      const text = await fetchLicenseFromGitHub(repoUrl);
      if (text) return text;
    } catch (err) {
      if (err.message.includes("rate limit")) {
        console.error(`  ${err.message} — skipping GitHub API fallback for remaining packages`);
      } else {
        console.warn(`  GitHub API fallback failed for ${key}: ${err.message}`);
      }
    }
  }

  // 3. Try manual license text
  if (manualTexts.has(key)) {
    return manualTexts.get(key);
  }

  return null;
}

async function main() {
  // Load config files (merge desktop + tenjo configs)
  const dualLicenseSelect = {
    ...(await loadJsonConfig(TENJO_DUAL_LICENSE_PATH)),
    ...(await loadJsonConfig(DUAL_LICENSE_PATH)),
  };

  const tenjoManualEntries = await loadJsonConfig(TENJO_MANUAL_LICENSE_TEXTS_PATH, []);
  const desktopManualEntries = await loadJsonConfig(MANUAL_LICENSE_TEXTS_PATH, []);
  const manualLicenseTexts = buildManualLicenseMap([...tenjoManualEntries, ...desktopManualEntries]);

  // Step 1: Collect production dependency keys
  const prodDepKeys = new Set();

  // 1a. tenjo workspace deps
  for (const ws of TENJO_WORKSPACES) {
    const keys = getTenjoProductionDepKeys(ws);
    for (const k of keys) {
      prodDepKeys.add(k);
    }
  }

  // 1b. tenjo-desktop root deps
  const desktopKeys = getDesktopProductionDepKeys();
  for (const k of desktopKeys) {
    prodDepKeys.add(k);
  }

  // Exclude own workspace packages
  const ownPackageNames = new Set();
  for (const ws of TENJO_WORKSPACES) {
    const raw = await fs.readFile(path.join(tenjoDir, ws, "package.json"), "utf8");
    ownPackageNames.add(JSON.parse(raw).name);
  }
  const tenjoRaw = await fs.readFile(path.join(tenjoDir, "package.json"), "utf8");
  ownPackageNames.add(JSON.parse(tenjoRaw).name);
  const desktopRaw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
  ownPackageNames.add(JSON.parse(desktopRaw).name);

  // Step 2: Scan all packages from both node_modules trees
  const [tenjoPackages, desktopPackages] = await Promise.all([
    scanLicenses(tenjoDir),
    scanLicenses(rootDir),
  ]);

  // Step 3: Merge and filter to production deps only
  const merged = new Map();

  for (const [key, info] of Object.entries(tenjoPackages)) {
    const atIdx = key.lastIndexOf("@");
    const pkgName = atIdx > 0 ? key.substring(0, atIdx) : key;
    if (ownPackageNames.has(pkgName)) continue;
    if (!prodDepKeys.has(key)) continue;
    merged.set(key, info);
  }

  for (const [key, info] of Object.entries(desktopPackages)) {
    const atIdx = key.lastIndexOf("@");
    const pkgName = atIdx > 0 ? key.substring(0, atIdx) : key;
    if (ownPackageNames.has(pkgName)) continue;
    if (!prodDepKeys.has(key)) continue;
    // Desktop packages may duplicate tenjo packages; keep first found
    if (!merged.has(key)) {
      merged.set(key, info);
    }
  }

  // Sort keys alphabetically for deterministic output
  const sortedKeys = [...merged.keys()].sort((a, b) => a.localeCompare(b, "en"));

  let report = "";
  const licenseSet = new Set();

  const unresolvedDualLicenses = [];
  const missingLicenseFiles = [];

  for (const key of sortedKeys) {
    const pkg = merged.get(key);
    const { licenses, repository, publisher, url } = pkg;

    // Resolve license: use override if available for dual-licensed packages
    const isDualLicensed = licenses && licenses.includes(" OR ");
    const resolvedLicense =
      isDualLicensed && dualLicenseSelect[key]
        ? dualLicenseSelect[key]
        : licenses;

    if (isDualLicensed && !dualLicenseSelect[key]) {
      unresolvedDualLicenses.push(`  ${key} (${licenses})`);
    }

    report += "--------------------------------------\n";
    report += `${key}\n`;
    if (repository) report += `Repository: ${repository}\n`;
    if (publisher) report += `Publisher: ${publisher}\n`;
    if (url) report += `URL: ${url}\n`;

    // Try to include actual license text
    const licenseText = await resolveLicenseText(key, pkg, manualLicenseTexts);
    if (licenseText) {
      report += `License Text:\n${licenseText}\n`;
    } else {
      report += "(No LICENSE file found)\n";
      missingLicenseFiles.push(`  ${key} (${resolvedLicense})`);
    }

    if (resolvedLicense) licenseSet.add(resolvedLicense);
  }

  // Ensure output directory exists
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, report, "utf8");

  console.log(`License report generated: ${OUTPUT_PATH}`);
  console.log(`Total unique packages: ${sortedKeys.length}`);
  console.log(`License types found: ${[...licenseSet].sort().join(", ")}`);

  // Warn about packages with no LICENSE file
  if (missingLicenseFiles.length > 0) {
    console.warn(
      `\nWARNING: The following packages have no LICENSE file (manual review required):\n${missingLicenseFiles.join("\n")}`,
    );
  }

  // Fail the build if there are unresolved dual-licensed packages
  if (unresolvedDualLicenses.length > 0) {
    console.error(
      `\nERROR: The following dual/multi-licensed packages need a license override in scripts/dual-license-select.json:\n${unresolvedDualLicenses.join("\n")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Failed to generate license report:", err);
  process.exit(1);
});
