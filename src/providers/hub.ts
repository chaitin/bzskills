import { createHash } from 'crypto';
import { parseFrontmatter } from '../frontmatter.ts';
import { sanitizeMetadata } from '../sanitize.ts';
import type { HostProvider, ProviderMatch, RemoteSkill } from './types.ts';
import type { WellKnownSkill, WellKnownSkillEntry } from './wellknown.ts';

interface HubPackageMetadata {
  owner: string;
  repo: string;
  skills: HubSkillSummary[];
}

interface HubSkillSummary {
  name: string;
  description: string;
  status?: string;
  entryPath?: string;
}

interface HubSkillMetadata extends HubSkillSummary {
  files?: HubSkillFile[];
}

interface HubSkillFile {
  path: string;
  contents?: string;
  digest?: string;
  url?: string;
}

export interface HubFetchDiagnostic {
  packageSkillCount: number;
  matchedSkillCount: number;
  fetchedSkillCount: number;
  failedSkillCount: number;
  failureReasons: Record<string, number>;
}

export interface HubFetchProgress {
  completed: number;
  total: number;
  skillName: string;
}

export interface HubRateLimiter {
  wait(): Promise<void>;
}

export interface HubFetchOptions {
  force?: boolean;
  subpath?: string;
  skillNames?: string[];
  concurrency?: number;
  onDiagnostic?: (diagnostic: HubFetchDiagnostic) => void;
  onProgress?: (progress: HubFetchProgress) => void;
  rateLimiter?: HubRateLimiter;
}

const DEFAULT_HUB_FETCH_CONCURRENCY = 8;
const DEFAULT_HUB_REQUESTS_PER_SECOND = 9;
const SECOND_MS = 1000;

class FixedWindowRateLimiter implements HubRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    maxRequests: number,
    windowMs: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
  }

  async wait(): Promise<void> {
    while (true) {
      const currentTime = this.now();
      while (this.timestamps.length > 0 && currentTime - this.timestamps[0]! >= this.windowMs) {
        this.timestamps.shift();
      }

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(currentTime);
        return;
      }

      await this.sleep(Math.max(1, this.windowMs - (currentTime - this.timestamps[0]!)));
    }
  }
}

function createDefaultHubRateLimiter(): HubRateLimiter {
  return new FixedWindowRateLimiter(DEFAULT_HUB_REQUESTS_PER_SECOND, SECOND_MS);
}

function withHubQuery(
  url: string,
  options: HubFetchOptions = {},
  queryOptions: { includeSkillNames?: boolean } = {}
): string {
  const names = queryOptions.includeSkillNames ? normalizedSkillNames(options.skillNames) : null;
  if (!options.force && !names) return url;
  const parsed = new URL(url);
  if (options.force) parsed.searchParams.set('force', 'true');
  if (names) {
    for (const name of names) {
      parsed.searchParams.append('skill', name);
    }
  }
  return parsed.toString();
}

function fileSetDigest(files: Map<string, string>, fileDigests: Map<string, string>): string {
  const parts = Array.from(files.keys())
    .map((path) => `${path}\0${fileDigests.get(path) ?? contentDigest(files.get(path) ?? '')}`)
    .sort();
  return contentDigest(parts.join('\n'));
}

function contentDigest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents, 'utf-8').digest('hex')}`;
}

function hasPathTraversal(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === '..');
}

function isSafeFilePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\')) return false;
  if (path.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function normalizedSkillNames(skillNames: string[] | undefined): Set<string> | null {
  if (!skillNames || skillNames.some((name) => name.trim() === '*')) {
    return null;
  }
  const names = skillNames
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  return names && names.length > 0 ? new Set(names) : null;
}

function matchesSkillName(skill: HubSkillSummary, names: Set<string> | null): boolean {
  if (!names) return true;
  return names.has(skill.name.toLowerCase());
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

type HubSkillFetchFailureReason =
  | 'skill_metadata_http_error'
  | 'missing_files'
  | 'unsafe_file_path'
  | 'file_fetch_failed'
  | 'missing_skill_md'
  | 'invalid_frontmatter'
  | 'skill_fetch_error';

interface HubSkillFetchResult {
  skill: WellKnownSkill | null;
  failureReason?: HubSkillFetchFailureReason;
}

function summarizeHubFetch(
  packageSkillCount: number,
  matchedSkillCount: number,
  fetched: HubSkillFetchResult[]
): HubFetchDiagnostic {
  const failureReasons: Record<string, number> = {};
  let fetchedSkillCount = 0;
  let failedSkillCount = 0;
  for (const result of fetched) {
    if (result.skill) {
      fetchedSkillCount += 1;
    } else {
      failedSkillCount += 1;
      const reason = result.failureReason ?? 'skill_fetch_error';
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }
  }
  return {
    packageSkillCount,
    matchedSkillCount,
    fetchedSkillCount,
    failedSkillCount,
    failureReasons,
  };
}

export class HubProvider implements HostProvider {
  readonly id = 'hub';
  readonly displayName = 'Skills Hub';

  match(url: string): ProviderMatch {
    try {
      const parsed = new URL(url);
      const matches = /^\/openapi\/v1\/skills\/[^/]+\/[^/]+\/?$/.test(parsed.pathname);
      return { matches, sourceIdentifier: matches ? this.getSourceIdentifier(url) : undefined };
    } catch {
      return { matches: false };
    }
  }

  async fetchSkill(url: string): Promise<RemoteSkill | null> {
    const skills = await this.fetchAllSkills(url);
    return skills.length === 1 ? skills[0]! : null;
  }

  async fetchAllSkills(url: string, options: HubFetchOptions = {}): Promise<WellKnownSkill[]> {
    try {
      const packageResponse = await fetch(withHubQuery(url, options, { includeSkillNames: true }));
      if (!packageResponse.ok) return [];
      const upstreamCommitSha = packageResponse.headers.get('X-Skills-Commit-SHA') || undefined;
      const metadata = (await packageResponse.json()) as HubPackageMetadata;
      const names = normalizedSkillNames(options.skillNames);
      const skills = metadata.skills.filter(
        (skill) => this.matchesSubpath(skill, options.subpath) && matchesSkillName(skill, names)
      );
      const rateLimiter = options.rateLimiter ?? createDefaultHubRateLimiter();
      let completed = 0;

      const fetched = await mapWithConcurrency(
        skills,
        options.concurrency ?? DEFAULT_HUB_FETCH_CONCURRENCY,
        async (skill) => {
          const result = await this.fetchSkillByName(
            url,
            skill.name,
            options,
            upstreamCommitSha,
            rateLimiter
          );
          completed += 1;
          options.onProgress?.({ completed, total: skills.length, skillName: skill.name });
          return result;
        }
      );
      options.onDiagnostic?.(summarizeHubFetch(metadata.skills.length, skills.length, fetched));
      return fetched
        .map((result) => result.skill)
        .filter((skill): skill is WellKnownSkill => skill !== null);
    } catch {
      return [];
    }
  }

  toRawUrl(url: string): string {
    return url;
  }

  getSourceIdentifier(url: string): string {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/openapi\/v1\/skills\/([^/]+)\/([^/]+)\/?$/);
      if (match) return `${match[1]}/${match[2]}`;
    } catch {
      // Fall through.
    }
    return 'unknown';
  }

  private matchesSubpath(skill: HubSkillSummary, subpath?: string): boolean {
    if (!subpath) return true;
    const normalizedSubpath = subpath.replace(/^\/+|\/+$/g, '');
    const entryPath = skill.entryPath?.replace(/^\/+|\/+$/g, '');
    return (
      entryPath === normalizedSubpath || entryPath?.startsWith(`${normalizedSubpath}/`) === true
    );
  }

  private async fetchSkillByName(
    packageUrl: string,
    skillName: string,
    options: HubFetchOptions = {},
    packageCommitSha: string | undefined,
    rateLimiter: HubRateLimiter
  ): Promise<HubSkillFetchResult> {
    try {
      const skillUrl = `${packageUrl.replace(/\/$/, '')}/skills/${encodeURIComponent(skillName)}`;
      await rateLimiter.wait();
      const response = await fetch(withHubQuery(skillUrl, options));
      if (!response.ok) return { skill: null, failureReason: 'skill_metadata_http_error' };
      const upstreamCommitSha = response.headers.get('X-Skills-Commit-SHA') || packageCommitSha;
      const metadata = (await response.json()) as HubSkillMetadata;
      if (!metadata.files || metadata.files.length === 0) {
        return { skill: null, failureReason: 'missing_files' };
      }

      const files = new Map<string, string>();
      const fileDigests = new Map<string, string>();
      for (const file of metadata.files) {
        if (!isSafeFilePath(file.path) || hasPathTraversal(file.path)) {
          return { skill: null, failureReason: 'unsafe_file_path' };
        }
        const contents =
          file.contents ?? (await this.fetchFile(packageUrl, file, options, rateLimiter));
        if (contents === null) return { skill: null, failureReason: 'file_fetch_failed' };
        files.set(file.path, contents);
        if (file.digest) fileDigests.set(file.path, file.digest);
      }

      const content = files.get('SKILL.md');
      if (!content) return { skill: null, failureReason: 'missing_skill_md' };
      const { data } = parseFrontmatter(content);
      if (typeof data.name !== 'string' || typeof data.description !== 'string') {
        return { skill: null, failureReason: 'invalid_frontmatter' };
      }

      const indexEntry: WellKnownSkillEntry = {
        name: metadata.name,
        description: metadata.description,
        files: Array.from(files.keys()),
        digest: fileSetDigest(files, fileDigests),
      };

      const sourceUrl = `${packageUrl.replace(/\/$/, '')}/skills/${encodeURIComponent(metadata.name)}`;
      const frontmatterMetadata =
        data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
          ? (data.metadata as Record<string, unknown>)
          : undefined;

      return {
        skill: {
          name: sanitizeMetadata(data.name),
          description: sanitizeMetadata(data.description),
          content,
          installName: metadata.name,
          sourceUrl,
          ...(upstreamCommitSha ? { upstreamCommitSha } : {}),
          metadata: frontmatterMetadata,
          files,
          indexEntry,
        },
      };
    } catch {
      return { skill: null, failureReason: 'skill_fetch_error' };
    }
  }

  private async fetchFile(
    packageUrl: string,
    file: HubSkillFile,
    options: HubFetchOptions = {},
    rateLimiter: HubRateLimiter
  ): Promise<string | null> {
    const fileUrl = file.url ?? `${packageUrl.replace(/\/$/, '')}/files/${file.path}`;
    if (!this.isTrustedFileURL(packageUrl, fileUrl)) return null;
    await rateLimiter.wait();
    const response = await fetch(withHubQuery(fileUrl, options));
    if (!response.ok) return null;
    return response.text();
  }

  private isTrustedFileURL(packageUrl: string, fileUrl: string): boolean {
    try {
      const pkg = new URL(packageUrl);
      const file = new URL(fileUrl);
      const basePath = pkg.pathname.replace(/\/$/, '');
      return file.origin === pkg.origin && file.pathname.startsWith(`${basePath}/files/`);
    } catch {
      return false;
    }
  }
}

export const hubProvider = new HubProvider();
