import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, runCliOutput, stripLogo, hasLogo } from './test-utils.ts';

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
