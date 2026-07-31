import path from "node:path";

export interface PathSafetyConfig {
  forbidDotPi: boolean;
  forbidObsidian: boolean;
  allowedObsidianSubpaths: string[];
}

export type PathValidation =
  { ok: true; normalized: string } | { ok: false; code: "PATH_INVALID" | "PATH_FORBIDDEN" };

/**
 * Validate a vault-relative path for safety.
 *
 * Rejects: empty, absolute, traversal (..), and (by default) .pi/ and
 * .obsidian/ prefixes. Returns the normalized vault-relative path on success.
 */
export function validateVaultPath(
  rawPath: string,
  vaultRoot: string,
  config: PathSafetyConfig,
): PathValidation {
  if (!rawPath || typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, code: "PATH_INVALID" };
  }

  // Reject absolute paths.
  if (path.isAbsolute(rawPath)) {
    return { ok: false, code: "PATH_INVALID" };
  }

  // Resolve against vault root and compute the relative path.
  const resolved = path.resolve(vaultRoot, rawPath);
  const rel = path.relative(vaultRoot, resolved);

  // If relative path escapes the vault root or is absolute (cross-drive on
  // Windows), it's a traversal attempt.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, code: "PATH_INVALID" };
  }

  const normalized = rel.split(path.sep).join("/");

  // Check forbidden top-level directories.
  const topSegment = normalized.split("/")[0];

  if (config.forbidDotPi && topSegment === ".pi") {
    return { ok: false, code: "PATH_FORBIDDEN" };
  }

  if (config.forbidObsidian && topSegment === ".obsidian") {
    const allowed = config.allowedObsidianSubpaths.some((sub) => {
      const s = sub.replace(/\\/g, "/");
      return normalized === s || normalized.startsWith(s + "/");
    });
    if (!allowed) {
      return { ok: false, code: "PATH_FORBIDDEN" };
    }
  }

  return { ok: true, normalized };
}
