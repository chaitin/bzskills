import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SKILLS_HUB_URL } from './source-parser.ts';
import { sendInstallReport } from './telemetry.ts';

describe('sendInstallReport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does not report installs to the default Hub', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const sent = await sendInstallReport(DEFAULT_SKILLS_HUB_URL, {
      source: 'alice/repo',
      skillName: 'remote-skill',
      digest: 'sha256:test',
      agents: ['opencode'],
      global: false,
    });

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not report installs to the configured Hub', async () => {
    vi.stubEnv('SKILLS_HUB_URL', 'https://custom-hub.example.com');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const sent = await sendInstallReport('https://custom-hub.example.com', {
      source: 'alice/repo',
      skillName: 'remote-skill',
      digest: 'sha256:test',
      agents: ['opencode'],
      global: false,
    });

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports installs to a custom request Hub against the canonical default Hub', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"created":true}', { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const sent = await sendInstallReport('https://custom-hub.example.com', {
      source: 'alice/repo',
      skillName: 'remote-skill',
      digest: 'sha256:test',
      upstreamCommitSha: 'commit-sha',
      agents: ['opencode'],
      global: true,
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://custom-hub.example.com/openapi/install-reports');
    expect(init).toBeDefined();
    expect(JSON.parse(String(init!.body))).toMatchObject({
      defaultHubUrl: DEFAULT_SKILLS_HUB_URL,
      source: 'alice/repo',
      skillName: 'remote-skill',
      digest: 'sha256:test',
      upstreamCommitSha: 'commit-sha',
      agents: ['opencode'],
      global: true,
    });
  });

  it('reports installs to the default Hub when explicitly requested', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"created":true}', { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const sent = await sendInstallReport(
      DEFAULT_SKILLS_HUB_URL,
      {
        source: 'anthropics/skills',
        skillName: 'test-skill',
        digest: 'sha256:test',
        agents: ['opencode'],
        global: false,
      },
      undefined,
      { reportDefaultHub: true }
    );

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_SKILLS_HUB_URL}/openapi/install-reports`);
    expect(JSON.parse(String(init!.body))).toMatchObject({
      defaultHubUrl: DEFAULT_SKILLS_HUB_URL,
      source: 'anthropics/skills',
      skillName: 'test-skill',
      digest: 'sha256:test',
    });
  });
});
