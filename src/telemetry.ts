import { getSkillsHubUrl } from './source-parser.ts';

interface SendInstallReportOptions {
  reportDefaultHub?: boolean;
  timeoutMs?: number;
}

const DEFAULT_INSTALL_REPORT_TIMEOUT_MS = 1500;

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
  source: string;
  skillName: string;
  digest: string;
}

export interface InstallReportSkillData {
  skillName: string;
  digest: string;
}

export interface InstallReportsData {
  source: string;
  sourceDomain?: string;
  skills: InstallReportSkillData[];
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
  defaultHubUrl = getSkillsHubUrl(),
  options: SendInstallReportOptions = {}
): Promise<boolean> {
  return sendInstallReports(
    requestHubUrl,
    {
      source: report.source,
      skills: [
        {
          skillName: report.skillName,
          digest: report.digest,
        },
      ],
    },
    defaultHubUrl,
    options
  );
}

export async function sendInstallReports(
  requestHubUrl: string,
  report: InstallReportsData,
  defaultHubUrl = getSkillsHubUrl(),
  options: SendInstallReportOptions = {}
): Promise<boolean> {
  const normalizedRequestHubUrl = normalizeHubUrl(requestHubUrl);
  const normalizedDefaultHubUrl = normalizeHubUrl(defaultHubUrl);

  if (!options.reportDefaultHub && normalizedRequestHubUrl === normalizedDefaultHubUrl) {
    return false;
  }

  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_REPORT_TIMEOUT_MS;
    const response = await fetch(`${normalizedRequestHubUrl}/openapi/install-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        source: report.source,
        ...(report.sourceDomain ? { sourceDomain: report.sourceDomain } : {}),
        skills: report.skills.map((skill) => ({
          skillName: skill.skillName,
          digest: skill.digest,
        })),
      }),
    });

    return response.ok;
  } catch {
    return false;
  }
}
