/**
 * Verifies that the project version is consistent everywhere it is declared:
 *   - package.json "version" is valid semver (major.minor.patch, optional -prerelease)
 *   - every docs/collections/*.postman_collection.json has info.version equal to it
 *
 * Usage: bun run version:check
 * Exit code 1 on any mismatch (used by CI).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const COLLECTIONS_DIR = 'docs/collections';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string };
const errors: string[] = [];

if (!pkg.version || !SEMVER.test(pkg.version)) {
  errors.push(`package.json version "${pkg.version}" is not valid semver (expected X.Y.Z)`);
}

const collections = readdirSync(COLLECTIONS_DIR).filter((f) => f.endsWith('.postman_collection.json'));
if (collections.length === 0) {
  errors.push(`no *.postman_collection.json found in ${COLLECTIONS_DIR}`);
}

for (const file of collections) {
  const collection = JSON.parse(readFileSync(join(COLLECTIONS_DIR, file), 'utf8')) as { info?: { version?: string } };
  const version = collection.info?.version;
  if (version !== pkg.version) {
    errors.push(`${COLLECTIONS_DIR}/${file}: info.version "${version}" != package.json "${pkg.version}"`);
  }
}

const openapiPath = 'docs/openapi.json';
try {
  const openapi = JSON.parse(readFileSync(openapiPath, 'utf8')) as { info?: { version?: string } };
  if (openapi.info?.version !== pkg.version) {
    errors.push(`${openapiPath}: info.version "${openapi.info?.version}" != package.json "${pkg.version}" (run: bun run openapi:export)`);
  }
} catch {
  errors.push(`${openapiPath} is missing (run: bun run openapi:export)`);
}

if (errors.length > 0) {
  console.error('Version check failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Version check OK: ${pkg.version} (package.json + ${collections.length} collection(s) + docs/openapi.json)`);
