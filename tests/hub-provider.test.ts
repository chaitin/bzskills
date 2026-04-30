import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { HubProvider } from '../src/providers/hub.ts';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/markdown' } });
}

function sha256(contents: string): string {
  return `sha256:${createHash('sha256').update(contents, 'utf-8').digest('hex')}`;
}

describe('HubProvider', () => {
  const provider = new HubProvider();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches native Skills Hub package URLs', () => {
    expect(provider.match('https://hub.example.com/openapi/v1/skills/alice/repo').matches).toBe(
      true
    );
    expect(provider.match('https://hub.example.com/alice/repo').matches).toBe(false);
    expect(
      provider.getSourceIdentifier('https://hub.example.com/openapi/v1/skills/alice/repo')
    ).toBe('alice/repo');
  });

  it('adapts native Hub metadata and file responses into installable skills', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo') {
        return jsonResponse({
          owner: 'alice',
          repo: 'repo',
          skills: [
            {
              name: 'remote-skill',
              description: 'Remote skill',
              status: 'pending',
              entryPath: 'skills/remote-skill',
            },
          ],
        });
      }
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo/skills/remote-skill') {
        return jsonResponse({
          name: 'remote-skill',
          description: 'Remote skill',
          status: 'pending',
          entryPath: 'skills/remote-skill',
          files: [
            {
              path: 'SKILL.md',
              digest: 'sha256:skill',
              url: 'https://hub.example.com/openapi/v1/skills/alice/repo/files/skills/remote-skill/SKILL.md',
            },
            {
              path: 'references/example.md',
              digest: 'sha256:ref',
              url: 'https://hub.example.com/openapi/v1/skills/alice/repo/files/skills/remote-skill/references/example.md',
            },
          ],
        });
      }
      if (url.endsWith('/SKILL.md')) {
        return textResponse(
          '---\nname: remote-skill\ndescription: Remote skill\n---\n\n# Remote\n'
        );
      }
      if (url.endsWith('/references/example.md')) {
        return textResponse('# Example\n');
      }
      return textResponse('missing', 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const skills = await provider.fetchAllSkills(
      'https://hub.example.com/openapi/v1/skills/alice/repo'
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]!.installName).toBe('remote-skill');
    expect(skills[0]!.files.get('SKILL.md')).toContain('name: remote-skill');
    expect(skills[0]!.files.get('references/example.md')).toBe('# Example\n');
    expect(skills[0]!.indexEntry.files).toEqual(['SKILL.md', 'references/example.md']);
    expect(skills[0]!.indexEntry.digest).toBe(
      sha256('SKILL.md\0sha256:skill\nreferences/example.md\0sha256:ref')
    );
  });

  it('captures upstream commit SHA from Hub response headers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo') {
        return jsonResponse(
          {
            owner: 'alice',
            repo: 'repo',
            skills: [{ name: 'remote-skill', description: 'Remote skill' }],
          },
          200,
          { 'X-Skills-Commit-SHA': 'package-sha' }
        );
      }
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo/skills/remote-skill') {
        return jsonResponse(
          {
            name: 'remote-skill',
            description: 'Remote skill',
            files: [
              {
                path: 'SKILL.md',
                digest: 'sha256:skill',
                contents: '---\nname: remote-skill\ndescription: Remote skill\n---\n\n# Remote\n',
              },
            ],
          },
          200,
          { 'X-Skills-Commit-SHA': 'skill-sha' }
        );
      }
      return textResponse('missing', 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const skills = await provider.fetchAllSkills(
      'https://hub.example.com/openapi/v1/skills/alice/repo'
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]!.upstreamCommitSha).toBe('skill-sha');
  });

  it('passes force=true to package, skill, and file requests', async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo?force=true') {
        return jsonResponse({
          owner: 'alice',
          repo: 'repo',
          skills: [
            { name: 'remote-skill', description: 'Remote skill', entryPath: 'skills/remote-skill' },
          ],
        });
      }
      if (
        url ===
        'https://hub.example.com/openapi/v1/skills/alice/repo/skills/remote-skill?force=true'
      ) {
        return jsonResponse({
          name: 'remote-skill',
          description: 'Remote skill',
          entryPath: 'skills/remote-skill',
          files: [
            {
              path: 'SKILL.md',
              url: 'https://hub.example.com/openapi/v1/skills/alice/repo/files/skills/remote-skill/SKILL.md',
            },
          ],
        });
      }
      if (
        url ===
        'https://hub.example.com/openapi/v1/skills/alice/repo/files/skills/remote-skill/SKILL.md?force=true'
      ) {
        return textResponse(
          '---\nname: remote-skill\ndescription: Remote skill\n---\n\n# Remote\n'
        );
      }
      return textResponse('missing', 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const skills = await provider.fetchAllSkills(
      'https://hub.example.com/openapi/v1/skills/alice/repo',
      {
        force: true,
      }
    );

    expect(skills).toHaveLength(1);
    expect(requestedUrls).toEqual([
      'https://hub.example.com/openapi/v1/skills/alice/repo?force=true',
      'https://hub.example.com/openapi/v1/skills/alice/repo/skills/remote-skill?force=true',
      'https://hub.example.com/openapi/v1/skills/alice/repo/files/skills/remote-skill/SKILL.md?force=true',
    ]);
  });

  it('filters skills by Hub subpath', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo') {
        return jsonResponse({
          owner: 'alice',
          repo: 'repo',
          skills: [
            { name: 'wanted', description: 'Wanted', entryPath: 'skills/wanted' },
            { name: 'other', description: 'Other', entryPath: 'skills/other' },
          ],
        });
      }
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo/skills/wanted') {
        return jsonResponse({
          name: 'wanted',
          description: 'Wanted',
          entryPath: 'skills/wanted',
          files: [
            {
              path: 'SKILL.md',
              url: 'https://hub.example.com/openapi/v1/skills/alice/repo/files/skills/wanted/SKILL.md',
            },
          ],
        });
      }
      if (url.endsWith('/skills/wanted/SKILL.md')) {
        return textResponse('---\nname: wanted\ndescription: Wanted\n---\n\n# Wanted\n');
      }
      return textResponse('missing', 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const skills = await provider.fetchAllSkills(
      'https://hub.example.com/openapi/v1/skills/alice/repo',
      {
        subpath: 'skills/wanted',
      }
    );

    expect(skills.map((skill) => skill.installName)).toEqual(['wanted']);
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://hub.example.com/openapi/v1/skills/alice/repo/skills/other'
    );
  });

  it.each(['../secret', 'C:/secret', 'dir\\file', './file', 'dir//file'])(
    'rejects unsafe file path %s from Hub metadata',
    async (path) => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo') {
          return jsonResponse({
            owner: 'alice',
            repo: 'repo',
            skills: [{ name: 'bad', description: 'Bad', entryPath: 'skills/bad' }],
          });
        }
        if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo/skills/bad') {
          return jsonResponse({
            name: 'bad',
            description: 'Bad',
            entryPath: 'skills/bad',
            files: [{ path, contents: 'secret' }],
          });
        }
        return textResponse('missing', 404);
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        provider.fetchAllSkills('https://hub.example.com/openapi/v1/skills/alice/repo')
      ).resolves.toEqual([]);
    }
  );

  it('rejects file URLs outside the requested Hub package', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo') {
        return jsonResponse({
          owner: 'alice',
          repo: 'repo',
          skills: [{ name: 'bad', description: 'Bad', entryPath: 'skills/bad' }],
        });
      }
      if (url === 'https://hub.example.com/openapi/v1/skills/alice/repo/skills/bad') {
        return jsonResponse({
          name: 'bad',
          description: 'Bad',
          entryPath: 'skills/bad',
          files: [{ path: 'SKILL.md', url: 'https://evil.example.com/SKILL.md' }],
        });
      }
      return textResponse('missing', 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      provider.fetchAllSkills('https://hub.example.com/openapi/v1/skills/alice/repo')
    ).resolves.toEqual([]);
  });
});
