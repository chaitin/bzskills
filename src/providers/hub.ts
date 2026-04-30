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

export interface HubFetchOptions {
  force?: boolean;
  subpath?: string;
}

function withHubQuery(url: string, options: HubFetchOptions = {}): string {
  if (!options.force) return url;
  const parsed = new URL(url);
  if (options.force) parsed.searchParams.set('force', 'true');
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
      const packageResponse = await fetch(withHubQuery(url, options));
      if (!packageResponse.ok) return [];
      const upstreamCommitSha = packageResponse.headers.get('X-Skills-Commit-SHA') || undefined;
      const metadata = (await packageResponse.json()) as HubPackageMetadata;
      const skills = metadata.skills.filter((skill) => this.matchesSubpath(skill, options.subpath));

      const fetched = await Promise.all(
        skills.map((skill) => this.fetchSkillByName(url, skill.name, options, upstreamCommitSha))
      );
      return fetched.filter((skill): skill is WellKnownSkill => skill !== null);
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
    packageCommitSha?: string
  ): Promise<WellKnownSkill | null> {
    try {
      const skillUrl = `${packageUrl.replace(/\/$/, '')}/skills/${encodeURIComponent(skillName)}`;
      const response = await fetch(withHubQuery(skillUrl, options));
      if (!response.ok) return null;
      const upstreamCommitSha = response.headers.get('X-Skills-Commit-SHA') || packageCommitSha;
      const metadata = (await response.json()) as HubSkillMetadata;
      if (!metadata.files || metadata.files.length === 0) return null;

      const files = new Map<string, string>();
      const fileDigests = new Map<string, string>();
      for (const file of metadata.files) {
        if (!isSafeFilePath(file.path) || hasPathTraversal(file.path)) {
          return null;
        }
        const contents = file.contents ?? (await this.fetchFile(packageUrl, file, options));
        if (contents === null) return null;
        files.set(file.path, contents);
        if (file.digest) fileDigests.set(file.path, file.digest);
      }

      const content = files.get('SKILL.md');
      if (!content) return null;
      const { data } = parseFrontmatter(content);
      if (typeof data.name !== 'string' || typeof data.description !== 'string') return null;

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
        name: sanitizeMetadata(data.name),
        description: sanitizeMetadata(data.description),
        content,
        installName: metadata.name,
        sourceUrl,
        ...(upstreamCommitSha ? { upstreamCommitSha } : {}),
        metadata: frontmatterMetadata,
        files,
        indexEntry,
      };
    } catch {
      return null;
    }
  }

  private async fetchFile(
    packageUrl: string,
    file: HubSkillFile,
    options: HubFetchOptions = {}
  ): Promise<string | null> {
    const fileUrl = file.url ?? `${packageUrl.replace(/\/$/, '')}/files/${file.path}`;
    if (!this.isTrustedFileURL(packageUrl, fileUrl)) return null;
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
