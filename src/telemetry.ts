import { getSkillsHubUrl } from './source-parser.ts';

interface InstallTelemetryData {
  event: 'install';
  source: string;
  skills: string;
  agents: string;
  global?: '1';
  skillFiles?: string; // JSON stringified { skillName: relativePath }
  /**
   * Source type for different hosts:
   * - 'github': GitHub repository (default, uses raw.githubusercontent.com)
   * - 'raw': Direct URL to SKILL.md (generic raw URL)
   * - Provider IDs like 'mintlify', 'huggingface', etc.
   */
  sourceType?: string;
}

interface RemoveTelemetryData {
  event: 'remove';
  source?: string;
  skills: string;
  agents: string;
  global?: '1';
  sourceType?: string;
}

interface UpdateTelemetryData {
  event: 'update';
  scope?: string;
  skillCount: string;
  successCount: string;
  failCount: string;
}

interface FindTelemetryData {
  event: 'find';
  query: string;
  resultCount: string;
  interactive?: '1';
}

interface SyncTelemetryData {
  event: 'experimental_sync';
  skillCount: string;
  successCount: string;
  agents: string;
}

type TelemetryData =
  | InstallTelemetryData
  | RemoveTelemetryData
  | UpdateTelemetryData
  | FindTelemetryData
  | SyncTelemetryData;

export function setVersion(version: string): void {
  void version;
}

// ─── Security audit data ───

export interface PartnerAudit {
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

export type SkillAuditData = Record<string, PartnerAudit>;
export type AuditResponse = Record<string, SkillAuditData>;

export interface InstallReportData {
  defaultHubUrl?: string;
  source: string;
  skillName: string;
  installedAt?: string;
  digest: string;
  upstreamCommitSha?: string;
  agents: string[];
  global: boolean;
}

function normalizeHubUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Fetch security audit results for skills from the audit API.
 * Returns null on any error or timeout — never blocks installation.
 */
export async function fetchAuditData(
  source: string,
  skillSlugs: string[],
  timeoutMs = 3000
): Promise<AuditResponse | null> {
  void source;
  void skillSlugs;
  void timeoutMs;
  return null;
}

export function track(data: TelemetryData): void {
  void data;
}

export async function sendInstallReport(
  requestHubUrl: string,
  report: InstallReportData,
  defaultHubUrl = getSkillsHubUrl()
): Promise<boolean> {
  const normalizedRequestHubUrl = normalizeHubUrl(requestHubUrl);
  const normalizedDefaultHubUrl = normalizeHubUrl(defaultHubUrl);

  if (normalizedRequestHubUrl === normalizedDefaultHubUrl) {
    return false;
  }

  try {
    const response = await fetch(`${normalizedRequestHubUrl}/openapi/install-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultHubUrl: normalizedDefaultHubUrl,
        source: report.source,
        skillName: report.skillName,
        installedAt: report.installedAt ?? new Date().toISOString(),
        digest: report.digest,
        upstreamCommitSha: report.upstreamCommitSha ?? '',
        agents: report.agents,
        global: report.global,
      }),
    });

    return response.ok;
  } catch {
    return false;
  }
}
