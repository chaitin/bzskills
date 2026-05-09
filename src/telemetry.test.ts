import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SKILLS_HUB_URL } from './source-parser.ts';
import { sendInstallReport, sendInstallReports } from './telemetry.ts';

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
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://custom-hub.example.com/openapi/install-reports');
    expect(init).toBeDefined();
    expect(JSON.parse(String(init!.body))).toMatchObject({
      source: 'alice/repo',
      skills: [
        {
          skillName: 'remote-skill',
          digest: 'sha256:test',
        },
      ],
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
      },
      undefined,
      { reportDefaultHub: true }
    );

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_SKILLS_HUB_URL}/openapi/install-reports`);
    expect(JSON.parse(String(init!.body))).toMatchObject({
      source: 'anthropics/skills',
      skills: [{ skillName: 'test-skill', digest: 'sha256:test' }],
    });
  });

  it('reports multiple installs in a single request', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"accepted":true}', { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const sent = await sendInstallReports('https://custom-hub.example.com', {
      source: 'alice/repo',
      skills: [
        { skillName: 'one-skill', digest: 'sha256:one' },
        { skillName: 'two-skill', digest: 'sha256:two' },
      ],
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init!.body))).toMatchObject({
      source: 'alice/repo',
      skills: [
        { skillName: 'one-skill', digest: 'sha256:one' },
        { skillName: 'two-skill', digest: 'sha256:two' },
      ],
    });
  });

  it('sets a timeout signal on install report requests', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"created":true}', { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendInstallReport(
      'https://custom-hub.example.com',
      {
        source: 'alice/repo',
        skillName: 'remote-skill',
        digest: 'sha256:test',
      },
      undefined,
      { timeoutMs: 1234 }
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
