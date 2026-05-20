import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, runCliOutput, stripAnsi, stripLogo, hasLogo } from './test-utils.ts';

const CLI_PATH = join(import.meta.dirname, 'cli.ts');

function sha256(contents: string): string {
  return `sha256:${createHash('sha256').update(contents, 'utf-8').digest('hex')}`;
}

async function withCustomHubServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer(handler);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      (server as Server).close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function withHubServer<T>(digest: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const skillContent = '---\nname: my-skill\ndescription: My skill\n---\n\n# My Skill\n';
  return withCustomHubServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi/v1/skills/owner/repo') {
      res.end(
        JSON.stringify({
          owner: 'owner',
          repo: 'repo',
          skills: [{ name: 'my-skill', description: 'My skill', entryPath: 'skills/my-skill' }],
        })
      );
      return;
    }
    if (req.url === '/openapi/v1/skills/owner/repo/skills/my-skill') {
      res.end(
        JSON.stringify({
          name: 'my-skill',
          description: 'My skill',
          entryPath: 'skills/my-skill',
          files: [{ path: 'SKILL.md', digest, contents: skillContent }],
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }, fn);
}

function writeGlobalLock(xdgStateHome: string, skills: Record<string, unknown>): void {
  const skillsDir = join(xdgStateHome, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, '.skill-lock.json'),
    JSON.stringify({ version: 3, skills }, null, 2),
    'utf-8'
  );
}

async function runCliAsync(
  args: string[],
  env?: Record<string, string>,
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: env ? { ...process.env, ...env } : undefined,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

describe('skills CLI', () => {
  describe('--help', () => {
    it('should display help message', () => {
      const output = runCliOutput(['--help']);
      expect(output).toContain('Usage: bzskills <command> [options]');
      expect(output).toContain('Manage Skills:');
      expect(output).toContain('init [name]');
      expect(output).toContain('add <package>');
      expect(output).toContain('update');
      expect(output).toContain('Add Options:');
      expect(output).toContain('-g, --global');
      expect(output).toContain('-a, --agent');
      expect(output).toContain('-s, --skill');
      expect(output).toContain('-l, --list');
      expect(output).toContain('-y, --yes');
      expect(output).toContain('--all');
    });

    it('should show same output for -h alias', () => {
      const helpOutput = runCliOutput(['--help']);
      const hOutput = runCliOutput(['-h']);
      expect(hOutput).toBe(helpOutput);
    });
  });

  describe('--version', () => {
    it('should display version number', () => {
      const output = runCliOutput(['--version']);
      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should match package.json version', () => {
      const output = runCliOutput(['--version']);
      const pkg = JSON.parse(
        readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8')
      );
      expect(output.trim()).toBe(pkg.version);
    });
  });

  describe('no arguments', () => {
    it('should display banner', () => {
      const output = stripLogo(runCliOutput([]));
      expect(output).toContain('The open agent skills ecosystem');
      expect(output).toContain('npx bzskills add');
      expect(output).toContain('npx bzskills update');
      expect(output).toContain('npx bzskills init');
      expect(output).toContain('configured Skills Hub');
    });
  });

  describe('unknown command', () => {
    it('should show error for unknown command', () => {
      const output = runCliOutput(['unknown-command']);
      expect(output).toMatchInlineSnapshot(`
        "Unknown command: unknown-command
        Run bzskills --help for usage.
        "
      `);
    });
  });

  describe('logo display', () => {
    it('should not display logo for list command', () => {
      const output = runCliOutput(['list']);
      expect(hasLogo(output)).toBe(false);
    });

    it('should not display logo for check command', () => {
      // Note: check command makes GitHub API calls, so we just verify initial output
      const output = runCliOutput(['check']);
      expect(hasLogo(output)).toBe(false);
    }, 60000);

    it('should not display logo for update command', () => {
      // Note: update command makes GitHub API calls, so we just verify initial output
      const output = runCliOutput(['update']);
      expect(hasLogo(output)).toBe(false);
    }, 60000);
  });

  describe('Hub update checks', () => {
    it('keeps sourceDomain in find results for same source repositories', async () => {
      await withCustomHubServer(
        (req, res) => {
          res.setHeader('content-type', 'application/json');
          if (
            req.url ===
            '/openapi/search?q=https%3A%2F%2Fgitlab.com%2Fgitlab-org%2Fai%2Fskills&limit=10'
          ) {
            res.end(
              JSON.stringify({
                skills: [
                  {
                    id: 'gitlab-org%2Fai/skills/skills/code-review',
                    name: 'code-review',
                    installs: 2,
                    source: 'https://gitlab.com/gitlab-org/ai/skills',
                    sourceDomain: 'gitlab.com',
                  },
                  {
                    id: 'gitlab-org%2Fai/skills/skills/code-review',
                    name: 'code-review',
                    installs: 1,
                    source: 'https://gitlab.com/gitlab-org/ai/skills',
                    source_domain: 'mirror.example.com',
                  },
                ],
              })
            );
            return;
          }
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'not found' }));
        },
        async (baseUrl) => {
          const result = await runCliAsync(['find', 'https://gitlab.com/gitlab-org/ai/skills'], {
            SKILLS_API_URL: baseUrl,
          });

          expect(result.exitCode).toBe(0);
          const stdout = stripAnsi(result.stdout);
          expect(stdout).toContain(
            'https://gitlab.com/gitlab-org/ai/skills?sourceDomain=gitlab.com --skill code-review 2 installs'
          );
          expect(stdout).toContain(
            'https://gitlab.com/gitlab-org/ai/skills?sourceDomain=mirror.example.com --skill code-review 1 install'
          );
          expect(stdout).toContain(
            `${baseUrl}/openapi/v1/skills/gitlab-org%2Fai/skills/skills/code-review?sourceDomain=gitlab.com`
          );
          expect(stdout).toContain(
            `${baseUrl}/openapi/v1/skills/gitlab-org%2Fai/skills/skills/code-review?sourceDomain=mirror.example.com`
          );
        }
      );
    }, 60000);

    it('stores native Hub sourceUrl in project lock for configured Hub installs', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'bzskills-project-'));
      try {
        await withHubServer('sha256:skill', async (baseUrl) => {
          const result = await runCliAsync(
            ['add', 'owner/repo', '-y', '--agent', 'claude-code'],
            {
              SKILLS_HUB_URL: baseUrl,
              XDG_STATE_HOME: join(projectDir, '.state'),
            },
            projectDir
          );

          expect(result.exitCode).toBe(0);
          const lock = JSON.parse(readFileSync(join(projectDir, 'skills-lock.json'), 'utf-8'));
          expect(lock.skills['my-skill']).toMatchObject({
            source: 'owner/repo',
            sourceType: 'hub',
            sourceUrl: `${baseUrl}/openapi/v1/skills/owner/repo`,
          });
        });
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60000);

    it('installs from explicit native Hub package URLs emitted by search', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'bzskills-project-'));
      try {
        await withHubServer('sha256:skill', async (baseUrl) => {
          const result = await runCliAsync(
            ['add', `${baseUrl}/openapi/v1/skills/owner/repo`, '-y', '--agent', 'claude-code'],
            { XDG_STATE_HOME: join(projectDir, '.state') },
            projectDir
          );

          expect(result.exitCode).toBe(0);
          const lock = JSON.parse(readFileSync(join(projectDir, 'skills-lock.json'), 'utf-8'));
          expect(lock.skills['my-skill']).toMatchObject({
            sourceType: 'hub',
            sourceUrl: `${baseUrl}/openapi/v1/skills/owner/repo`,
          });
        });
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60000);

    it('ignores --direct for explicit native Hub package URLs', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'bzskills-project-'));
      try {
        await withHubServer('sha256:skill', async (baseUrl) => {
          const result = await runCliAsync(
            [
              'add',
              `${baseUrl}/openapi/v1/skills/owner/repo`,
              '--direct',
              '-y',
              '--agent',
              'claude-code',
            ],
            { XDG_STATE_HOME: join(projectDir, '.state') },
            projectDir
          );

          expect(result.exitCode).toBe(0);
          const lock = JSON.parse(readFileSync(join(projectDir, 'skills-lock.json'), 'utf-8'));
          expect(lock.skills['my-skill']).toMatchObject({
            sourceType: 'hub',
            sourceUrl: `${baseUrl}/openapi/v1/skills/owner/repo`,
          });
        });
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60000);

    it('passes --skill filters to native Hub package metadata requests', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'bzskills-project-'));
      const requested: string[] = [];
      const skillContent = '---\nname: my-skill\ndescription: My skill\n---\n\n# My Skill\n';

      try {
        await withCustomHubServer(
          (req, res) => {
            requested.push(req.url || '');
            res.setHeader('content-type', 'application/json');
            if (req.url === '/openapi/v1/skills/owner/repo?skill=my-skill') {
              res.end(
                JSON.stringify({
                  owner: 'owner',
                  repo: 'repo',
                  skills: [
                    { name: 'my-skill', description: 'My skill', entryPath: 'skills/my-skill' },
                  ],
                })
              );
              return;
            }
            if (req.url === '/openapi/v1/skills/owner/repo/skills/my-skill') {
              res.end(
                JSON.stringify({
                  name: 'my-skill',
                  description: 'My skill',
                  entryPath: 'skills/my-skill',
                  files: [{ path: 'SKILL.md', digest: 'sha256:skill', contents: skillContent }],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            const result = await runCliAsync(
              ['add', 'owner/repo', '--skill', 'my-skill', '-y', '--agent', 'claude-code'],
              {
                SKILLS_HUB_URL: baseUrl,
                XDG_STATE_HOME: join(projectDir, '.state'),
              },
              projectDir
            );

            expect(result.exitCode).toBe(0);
            expect(requested).toEqual([
              '/openapi/v1/skills/owner/repo?skill=my-skill',
              '/openapi/v1/skills/owner/repo/skills/my-skill',
            ]);
          }
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60000);

    it('routes non-GitHub git URLs through Hub with source origin by default', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'bzskills-project-'));
      const requested: string[] = [];
      const skillContent =
        '---\nname: gitops-app-onboarding\ndescription: GitOps onboarding\n---\n\n# GitOps\n';
      const sourceDomain = 'example.com';
      const encodedSourceDomain = encodeURIComponent(sourceDomain);

      try {
        await withCustomHubServer(
          (req, res) => {
            requested.push(req.url || '');
            res.setHeader('content-type', 'application/json');
            if (
              req.url ===
              `/openapi/v1/skills/vercel-labs/agent-skills?sourceDomain=${encodedSourceDomain}&skill=gitops-app-onboarding`
            ) {
              res.end(
                JSON.stringify({
                  owner: 'vercel-labs',
                  repo: 'agent-skills',
                  skills: [
                    {
                      name: 'gitops-app-onboarding',
                      description: 'GitOps onboarding',
                      entryPath: 'skills/gitops-app-onboarding',
                    },
                  ],
                })
              );
              return;
            }
            if (
              req.url ===
              `/openapi/v1/skills/vercel-labs/agent-skills/skills/gitops-app-onboarding?sourceDomain=${encodedSourceDomain}`
            ) {
              res.end(
                JSON.stringify({
                  name: 'gitops-app-onboarding',
                  description: 'GitOps onboarding',
                  entryPath: 'skills/gitops-app-onboarding',
                  files: [{ path: 'SKILL.md', digest: 'sha256:skill', contents: skillContent }],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            const result = await runCliAsync(
              [
                'add',
                'https://example.com/vercel-labs/agent-skills.git',
                '--skill',
                'gitops-app-onboarding',
                '-y',
                '--agent',
                'claude-code',
              ],
              {
                SKILLS_HUB_URL: baseUrl,
                XDG_STATE_HOME: join(projectDir, '.state'),
              },
              projectDir
            );

            expect(result.exitCode).toBe(0);
            expect(requested).toEqual([
              `/openapi/v1/skills/vercel-labs/agent-skills?sourceDomain=${encodedSourceDomain}&skill=gitops-app-onboarding`,
              `/openapi/v1/skills/vercel-labs/agent-skills/skills/gitops-app-onboarding?sourceDomain=${encodedSourceDomain}`,
            ]);

            const lock = JSON.parse(readFileSync(join(projectDir, 'skills-lock.json'), 'utf-8'));
            expect(lock.skills['gitops-app-onboarding']).toMatchObject({
              source: 'vercel-labs/agent-skills',
              sourceType: 'hub',
              sourceUrl: `${baseUrl}/openapi/v1/skills/vercel-labs/agent-skills`,
              sourceDomain,
            });
          }
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60000);

    it('routes GitLab subgroup URLs through Hub with encoded owner by default', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'bzskills-project-'));
      const requested: string[] = [];
      const skillContent =
        '---\nname: code-review\ndescription: Code review\n---\n\n# Code Review\n';

      try {
        await withCustomHubServer(
          (req, res) => {
            requested.push(req.url || '');
            res.setHeader('content-type', 'application/json');
            if (req.url === '/openapi/v1/skills/gitlab-org%2Fai/skills?sourceDomain=gitlab.com') {
              res.end(
                JSON.stringify({
                  owner: 'gitlab-org/ai',
                  repo: 'skills',
                  skills: [{ name: 'code-review', description: 'Code review' }],
                })
              );
              return;
            }
            if (
              req.url ===
              '/openapi/v1/skills/gitlab-org%2Fai/skills/skills/code-review?sourceDomain=gitlab.com'
            ) {
              res.end(
                JSON.stringify({
                  name: 'code-review',
                  description: 'Code review',
                  files: [{ path: 'SKILL.md', digest: 'sha256:skill', contents: skillContent }],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            const result = await runCliAsync(
              ['add', 'https://gitlab.com/gitlab-org/ai/skills', '-y', '--agent', 'claude-code'],
              {
                SKILLS_HUB_URL: baseUrl,
                XDG_STATE_HOME: join(projectDir, '.state'),
              },
              projectDir
            );

            expect(result.exitCode).toBe(0);
            expect(requested).toEqual([
              '/openapi/v1/skills/gitlab-org%2Fai/skills?sourceDomain=gitlab.com',
              '/openapi/v1/skills/gitlab-org%2Fai/skills/skills/code-review?sourceDomain=gitlab.com',
            ]);

            const lock = JSON.parse(readFileSync(join(projectDir, 'skills-lock.json'), 'utf-8'));
            expect(lock.skills['code-review']).toMatchObject({
              source: 'gitlab-org/ai/skills',
              sourceType: 'hub',
              sourceUrl: `${baseUrl}/openapi/v1/skills/gitlab-org%2Fai/skills`,
              sourceDomain: 'gitlab.com',
            });
          }
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60000);

    it('keeps Hub skill fetch progress on the spinner line while adding skills', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'bzskills-project-'));
      try {
        await withCustomHubServer(
          (req, res) => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/openapi/v1/skills/owner/repo') {
              res.end(
                JSON.stringify({
                  owner: 'owner',
                  repo: 'repo',
                  skills: [
                    { name: 'first-skill', description: 'First skill' },
                    { name: 'second-skill', description: 'Second skill' },
                  ],
                })
              );
              return;
            }
            const skillMatch = req.url?.match(
              /^\/openapi\/v1\/skills\/owner\/repo\/skills\/(first-skill|second-skill)$/
            );
            if (skillMatch) {
              const skillName = skillMatch[1]!;
              res.end(
                JSON.stringify({
                  name: skillName,
                  description: skillName,
                  files: [
                    {
                      path: 'SKILL.md',
                      digest: `sha256:${skillName}`,
                      contents: `---\nname: ${skillName}\ndescription: ${skillName}\n---\n\n# ${skillName}\n`,
                    },
                  ],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            const result = await runCliAsync(
              ['add', 'owner/repo', '-y', '--agent', 'claude-code'],
              {
                SKILLS_HUB_URL: baseUrl,
                XDG_STATE_HOME: join(projectDir, '.state'),
              },
              projectDir
            );

            expect(result.exitCode).toBe(0);
            const stdout = stripAnsi(result.stdout);
            expect(stdout).not.toContain('1/2 first-skill');
            expect(stdout).not.toContain('2/2 second-skill');
            expect(stdout).toContain('Fetched 2 skills');
          }
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, 60000);

    it('checks Hub global skills by digest instead of skipping them', async () => {
      const fileDigest = 'sha256:skill';
      const hubDigest = sha256(`SKILL.md\0${fileDigest}`);
      const stateHome = mkdtempSync(join(tmpdir(), 'bzskills-state-'));

      try {
        await withHubServer(fileDigest, async (baseUrl) => {
          writeGlobalLock(stateHome, {
            'my-skill': {
              source: 'owner/repo',
              sourceType: 'hub',
              sourceUrl: `${baseUrl}/openapi/v1/skills/owner/repo/skills/my-skill`,
              skillFolderHash: hubDigest,
              installedAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          });

          const result = await runCliAsync(['check', '-g'], { XDG_STATE_HOME: stateHome });

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain('All global skills are up to date');
          expect(result.stdout).not.toContain('Hub skill');
          expect(result.stdout).not.toContain('cannot be checked automatically');
        });
      } finally {
        rmSync(stateHome, { recursive: true, force: true });
      }
    }, 60000);

    it('passes --force but ignores locked ref for Hub update checks', async () => {
      const fileDigest = 'sha256:skill';
      const hubDigest = sha256(`SKILL.md\0${fileDigest}`);
      const stateHome = mkdtempSync(join(tmpdir(), 'bzskills-state-'));
      const requested: string[] = [];

      try {
        await withCustomHubServer(
          (req, res) => {
            requested.push(req.url || '');
            res.setHeader('content-type', 'application/json');
            if (req.url === '/openapi/v1/skills/owner/repo?force=true') {
              res.end(
                JSON.stringify({
                  owner: 'owner',
                  repo: 'repo',
                  skills: [{ name: 'my-skill', description: 'My skill' }],
                })
              );
              return;
            }
            if (req.url === '/openapi/v1/skills/owner/repo/skills/my-skill?force=true') {
              res.end(
                JSON.stringify({
                  name: 'my-skill',
                  description: 'My skill',
                  files: [
                    {
                      path: 'SKILL.md',
                      digest: fileDigest,
                      contents: '---\nname: my-skill\ndescription: My skill\n---\n\n# My Skill\n',
                    },
                  ],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            writeGlobalLock(stateHome, {
              'my-skill': {
                source: 'owner/repo',
                sourceType: 'hub',
                sourceUrl: `${baseUrl}/openapi/v1/skills/owner/repo/skills/my-skill`,
                ref: 'feature/install',
                skillFolderHash: hubDigest,
                installedAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            });

            const result = await runCliAsync(['check', '-g', '--force'], {
              XDG_STATE_HOME: stateHome,
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('All global skills are up to date');
            expect(requested).toEqual([
              '/openapi/v1/skills/owner/repo?force=true',
              '/openapi/v1/skills/owner/repo/skills/my-skill?force=true',
            ]);
          }
        );
      } finally {
        rmSync(stateHome, { recursive: true, force: true });
      }
    }, 60000);

    it('passes locked upstream sourceUrl to Hub update checks', async () => {
      const fileDigest = 'sha256:skill';
      const hubDigest = sha256(`SKILL.md\0${fileDigest}`);
      const stateHome = mkdtempSync(join(tmpdir(), 'bzskills-state-'));
      const requested: string[] = [];
      const sourceDomain = 'example.com';
      const encodedSourceUrl = encodeURIComponent(sourceDomain);

      try {
        await withCustomHubServer(
          (req, res) => {
            requested.push(req.url || '');
            res.setHeader('content-type', 'application/json');
            if (
              req.url ===
              `/openapi/v1/skills/vercel-labs/agent-skills?sourceDomain=${encodedSourceUrl}`
            ) {
              res.end(
                JSON.stringify({
                  owner: 'vercel-labs',
                  repo: 'agent-skills',
                  skills: [{ name: 'gitops-app-onboarding', description: 'GitOps onboarding' }],
                })
              );
              return;
            }
            if (
              req.url ===
              `/openapi/v1/skills/vercel-labs/agent-skills/skills/gitops-app-onboarding?sourceDomain=${encodedSourceUrl}`
            ) {
              res.end(
                JSON.stringify({
                  name: 'gitops-app-onboarding',
                  description: 'GitOps onboarding',
                  files: [
                    {
                      path: 'SKILL.md',
                      digest: fileDigest,
                      contents:
                        '---\nname: gitops-app-onboarding\ndescription: GitOps onboarding\n---\n\n# GitOps\n',
                    },
                  ],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            writeGlobalLock(stateHome, {
              'gitops-app-onboarding': {
                source: 'vercel-labs/agent-skills',
                sourceType: 'hub',
                sourceUrl: `${baseUrl}/openapi/v1/skills/vercel-labs/agent-skills/skills/gitops-app-onboarding`,
                sourceDomain,
                skillFolderHash: hubDigest,
                installedAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            });

            const result = await runCliAsync(['check', '-g'], { XDG_STATE_HOME: stateHome });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('All global skills are up to date');
            expect(requested).toEqual([
              `/openapi/v1/skills/vercel-labs/agent-skills?sourceDomain=${encodedSourceUrl}`,
              `/openapi/v1/skills/vercel-labs/agent-skills/skills/gitops-app-onboarding?sourceDomain=${encodedSourceUrl}`,
            ]);
          }
        );
      } finally {
        rmSync(stateHome, { recursive: true, force: true });
      }
    }, 60000);

    it('skips legacy Hub global locks that do not have a digest', () => {
      const stateHome = mkdtempSync(join(tmpdir(), 'bzskills-state-'));

      try {
        writeGlobalLock(stateHome, {
          'my-skill': {
            source: 'owner/repo',
            sourceType: 'hub',
            sourceUrl: 'https://hub.example.com/openapi/v1/skills/owner/repo/skills/my-skill',
            skillFolderHash: '',
            installedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        });

        const result = runCli(['check', '-g'], undefined, { XDG_STATE_HOME: stateHome });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No Hub digest recorded');
        expect(result.stdout).toContain('npx bzskills add owner/repo -g -y');
      } finally {
        rmSync(stateHome, { recursive: true, force: true });
      }
    }, 60000);

    it('skips Hub global skills when the package fetch returns no skills', async () => {
      const stateHome = mkdtempSync(join(tmpdir(), 'bzskills-state-'));

      try {
        await withCustomHubServer(
          (req, res) => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/openapi/v1/skills/owner/repo') {
              res.end(JSON.stringify({ owner: 'owner', repo: 'repo', skills: [] }));
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            writeGlobalLock(stateHome, {
              'my-skill': {
                source: 'owner/repo',
                sourceType: 'hub',
                sourceUrl: `${baseUrl}/openapi/v1/skills/owner/repo/skills/my-skill`,
                skillFolderHash: 'sha256:old',
                installedAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            });

            const result = await runCliAsync(['check', '-g'], { XDG_STATE_HOME: stateHome });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('Hub skill unavailable');
            expect(result.stdout).toContain('npx bzskills add owner/repo -g -y');
            expect(result.stdout).not.toContain('All global skills are up to date');
          }
        );
      } finally {
        rmSync(stateHome, { recursive: true, force: true });
      }
    }, 60000);

    it('skips Hub global skills when the locked skill is absent from the package', async () => {
      const stateHome = mkdtempSync(join(tmpdir(), 'bzskills-state-'));
      const otherContent = '---\nname: other-skill\ndescription: Other skill\n---\n\n# Other\n';

      try {
        await withCustomHubServer(
          (req, res) => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/openapi/v1/skills/owner/repo') {
              res.end(
                JSON.stringify({
                  owner: 'owner',
                  repo: 'repo',
                  skills: [{ name: 'other-skill', description: 'Other skill' }],
                })
              );
              return;
            }
            if (req.url === '/openapi/v1/skills/owner/repo/skills/other-skill') {
              res.end(
                JSON.stringify({
                  name: 'other-skill',
                  description: 'Other skill',
                  files: [{ path: 'SKILL.md', digest: 'sha256:other', contents: otherContent }],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
          },
          async (baseUrl) => {
            writeGlobalLock(stateHome, {
              'my-skill': {
                source: 'owner/repo',
                sourceType: 'hub',
                sourceUrl: `${baseUrl}/openapi/v1/skills/owner/repo/skills/my-skill`,
                skillFolderHash: 'sha256:old',
                installedAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            });

            const result = await runCliAsync(['check', '-g'], { XDG_STATE_HOME: stateHome });

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('Hub skill unavailable');
            expect(result.stdout).not.toContain('All global skills are up to date');
          }
        );
      } finally {
        rmSync(stateHome, { recursive: true, force: true });
      }
    }, 60000);

    it('skips Hub global skills when the lock has an invalid Hub source URL', () => {
      const stateHome = mkdtempSync(join(tmpdir(), 'bzskills-state-'));

      try {
        writeGlobalLock(stateHome, {
          'my-skill': {
            source: 'owner/repo',
            sourceType: 'hub',
            sourceUrl: 'https://hub.example.com/not-a-native-hub-url',
            skillFolderHash: 'sha256:old',
            installedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        });

        const result = runCli(['check', '-g'], undefined, { XDG_STATE_HOME: stateHome });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Invalid Hub package URL');
        expect(result.stdout).toContain('npx bzskills add owner/repo -g -y');
        expect(result.stdout).not.toContain('All global skills are up to date');
      } finally {
        rmSync(stateHome, { recursive: true, force: true });
      }
    }, 60000);
  });
});
