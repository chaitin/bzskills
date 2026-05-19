import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as p from '@clack/prompts';
import { runAdd } from './add.ts';
import { DEFAULT_SKILLS_HUB_URL, isRepoPrivate } from './source-parser.ts';
import { sendInstallReports } from './telemetry.ts';

vi.mock('./git.ts', async () => {
  const actual = await vi.importActual<typeof import('./git.ts')>('./git.ts');
  return {
    ...actual,
    cloneRepo: vi.fn(),
    cleanupTempDir: vi.fn(),
  };
});

vi.mock('./source-parser.ts', async () => {
  const actual = await vi.importActual<typeof import('./source-parser.ts')>('./source-parser.ts');
  return {
    ...actual,
    isRepoPrivate: vi.fn(async () => false),
  };
});

vi.mock('./telemetry.ts', async () => {
  const actual = await vi.importActual<typeof import('./telemetry.ts')>('./telemetry.ts');
  return {
    ...actual,
    track: vi.fn(),
    sendInstallReports: vi.fn(async () => true),
  };
});

function sha256(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function fileSetDigest(files: Array<{ path: string; contents: string }>): string {
  const parts = files.map((file) => `${file.path}\0${sha256(file.contents)}`).sort();
  return sha256(parts.join('\n'));
}

describe('GitHub add install reporting', () => {
  let repoDir: string;
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    const root = join(tmpdir(), `bzskills-github-report-${Date.now()}-${Math.random()}`);
    repoDir = join(root, 'repo');
    cwd = join(root, 'project');
    await mkdir(join(repoDir, 'skills', 'test-skill'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(repoDir, 'skills', 'test-skill', 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test skill\n---\n\n# Test Skill\n',
      'utf-8'
    );
    await writeFile(
      join(repoDir, 'skills', 'test-skill', 'notes.json'),
      '{"usage":"supported text asset"}',
      'utf-8'
    );
    await writeFile(join(repoDir, 'skills', 'test-skill', 'image.png'), 'ignored', 'utf-8');
    process.chdir(cwd);

    const git = await import('./git.ts');
    vi.mocked(git.cloneRepo).mockResolvedValue(repoDir);
    vi.mocked(isRepoPrivate).mockResolvedValue(false);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('reports successful direct GitHub installs to the configured Hub', async () => {
    const expectedDigest = fileSetDigest([
      {
        path: 'SKILL.md',
        contents: '---\nname: test-skill\ndescription: Test skill\n---\n\n# Test Skill\n',
      },
      { path: 'notes.json', contents: '{"usage":"supported text asset"}' },
    ]);

    await runAdd(['https://github.com/anthropics/skills'], {
      yes: true,
      agent: ['opencode'],
      skill: ['test-skill'],
      global: false,
    });

    expect(sendInstallReports).toHaveBeenCalledTimes(1);
    expect(sendInstallReports).toHaveBeenCalledWith(
      DEFAULT_SKILLS_HUB_URL,
      expect.objectContaining({
        source: 'anthropics/skills',
        sourceUrl: 'https://github.com/anthropics/skills.git',
        skills: [{ skillName: 'test-skill', digest: expectedDigest }],
      }),
      undefined,
      { reportDefaultHub: true }
    );
  });

  it('reports multiple successful direct GitHub installs in one batch', async () => {
    await mkdir(join(repoDir, 'skills', 'another-skill'), { recursive: true });
    await writeFile(
      join(repoDir, 'skills', 'another-skill', 'SKILL.md'),
      '---\nname: another-skill\ndescription: Another skill\n---\n\n# Another Skill\n',
      'utf-8'
    );

    await runAdd(['https://github.com/anthropics/skills'], {
      yes: true,
      agent: ['opencode'],
      global: false,
    });

    expect(sendInstallReports).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(sendInstallReports).mock.calls[0]!;
    expect(payload.skills.map((skill) => skill.skillName).sort()).toEqual([
      'another-skill',
      'test-skill',
    ]);
  });

  it.each([true, null])('reports even when GitHub privacy is %s', async (privacy) => {
    vi.mocked(isRepoPrivate).mockResolvedValue(privacy);

    await runAdd(['https://github.com/anthropics/skills'], {
      yes: true,
      agent: ['opencode'],
      skill: ['test-skill'],
      global: false,
    });

    expect(sendInstallReports).toHaveBeenCalledTimes(1);
  });

  it('does not warn about report failures without debug', async () => {
    vi.mocked(sendInstallReports).mockResolvedValueOnce(false);
    const warnSpy = vi.spyOn(p.log, 'warn');

    await runAdd(['https://github.com/anthropics/skills'], {
      yes: true,
      agent: ['opencode'],
      skill: ['test-skill'],
      global: false,
    });

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('could not be sent'));
  });

  it('warns about report failures with debug', async () => {
    vi.mocked(sendInstallReports).mockResolvedValueOnce(false);
    const warnSpy = vi.spyOn(p.log, 'warn');

    await runAdd(['https://github.com/anthropics/skills'], {
      yes: true,
      agent: ['opencode'],
      skill: ['test-skill'],
      global: false,
      debug: true,
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not be sent'));
  });

  it('reports successful non-GitHub direct git installs with sourceUrl', async () => {
    await runAdd(['https://deploy.baizhi.cloud/gitops-admin/agent-skills.git'], {
      yes: true,
      agent: ['opencode'],
      skill: ['test-skill'],
      global: false,
      fullDepth: true,
    });

    expect(sendInstallReports).toHaveBeenCalledTimes(1);
    expect(sendInstallReports).toHaveBeenCalledWith(
      DEFAULT_SKILLS_HUB_URL,
      expect.objectContaining({
        source: 'gitops-admin/agent-skills',
        sourceUrl: 'https://deploy.baizhi.cloud/gitops-admin/agent-skills.git',
        skills: [expect.objectContaining({ skillName: 'test-skill' })],
      }),
      undefined,
      { reportDefaultHub: true }
    );
  });
});
