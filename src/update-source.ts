export interface UpdateSourceEntry {
  source: string;
  sourceType?: string;
  sourceUrl: string;
  sourceDomain?: string;
  upstreamSourceUrl?: string;
  ref?: string;
  skillPath?: string;
}

export interface LocalUpdateSourceEntry {
  source: string;
  sourceUrl?: string;
  sourceDomain?: string;
  upstreamSourceUrl?: string;
  sourceType?: string;
  ref?: string;
}

export function formatSourceInput(sourceUrl: string, ref?: string): string {
  if (!ref) {
    return sourceUrl;
  }
  return `${sourceUrl}#${ref}`;
}

export function legacySourceDomain(sourceUrl?: string): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    return new URL(sourceUrl).host;
  } catch {
    return sourceUrl;
  }
}

function resolvedSourceDomain(entry: {
  sourceDomain?: string;
  upstreamSourceUrl?: string;
}): string | undefined {
  return entry.sourceDomain ?? legacySourceDomain(entry.upstreamSourceUrl);
}

function sourceDomainParam(entry: { sourceDomain?: string; upstreamSourceUrl?: string }): string {
  const domain = resolvedSourceDomain(entry);
  return domain ? `?sourceDomain=${encodeURIComponent(domain)}` : '';
}

function nativeHubInstallSource(
  entry: { source: string; sourceUrl?: string; sourceDomain?: string; upstreamSourceUrl?: string },
  skillName?: string
): string {
  if (!resolvedSourceDomain(entry) || !entry.sourceUrl) {
    return formatHubSkillSource(entry.source, skillName);
  }

  const packageUrl = entry.sourceUrl.replace(/\/skills\/[^/?#]+(?:[?#].*)?$/, '');
  const skillUrl = skillName ? `${packageUrl}/skills/${encodeURIComponent(skillName)}` : packageUrl;
  return `${skillUrl}${sourceDomainParam(entry)}`;
}

function formatHubSkillSource(source: string, skillName?: string): string {
  return skillName ? `${source}@${skillName}` : source;
}

/**
 * Build the source argument for `skills add` during update.
 * Uses shorthand form for path-targeted updates to avoid branch/path ambiguity.
 */
export function buildUpdateInstallSource(entry: UpdateSourceEntry, skillName?: string): string {
  if (entry.sourceType === 'hub') {
    return nativeHubInstallSource(entry, skillName);
  }

  if (!entry.skillPath) {
    return formatSourceInput(entry.sourceUrl, entry.ref);
  }

  // Extract skill folder from skillPath (remove /SKILL.md suffix).
  let skillFolder = entry.skillPath;
  if (skillFolder.endsWith('/SKILL.md')) {
    skillFolder = skillFolder.slice(0, -9);
  } else if (skillFolder.endsWith('SKILL.md')) {
    skillFolder = skillFolder.slice(0, -8);
  }
  if (skillFolder.endsWith('/')) {
    skillFolder = skillFolder.slice(0, -1);
  }

  let installSource = skillFolder ? `${entry.source}/${skillFolder}` : entry.source;
  if (entry.ref) {
    installSource = `${installSource}#${entry.ref}`;
  }
  return installSource;
}

/**
 * Build the source argument for `skills add` during project-level update.
 * Local lock entries only have `source` and `ref` (no skillPath or sourceUrl),
 * so we use the source directly (e.g., "vercel-labs/agent-skills").
 */
export function buildLocalUpdateSource(entry: LocalUpdateSourceEntry, skillName?: string): string {
  if (entry.sourceType === 'hub') {
    return nativeHubInstallSource(entry, skillName);
  }

  if (entry.sourceUrl) {
    return formatSourceInput(entry.sourceUrl, entry.ref);
  }

  return formatSourceInput(entry.source, entry.ref);
}

export function hubEnvFromSourceUrl(sourceUrl?: string): Record<string, string> {
  if (!sourceUrl) return {};
  try {
    const parsed = new URL(sourceUrl);
    if (!/^\/openapi\/v1\/skills\/[^/]+\/[^/]+(?:\/skills\/[^/]+)?\/?$/.test(parsed.pathname)) {
      return {};
    }
    return { SKILLS_HUB_URL: parsed.origin };
  } catch {
    return {};
  }
}
