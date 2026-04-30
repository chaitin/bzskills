import { describe, it, expect } from 'vitest';
import {
  buildLocalUpdateSource,
  buildUpdateInstallSource,
  formatSourceInput,
  hubEnvFromSourceUrl,
} from './update-source.ts';

describe('update-source', () => {
  describe('formatSourceInput', () => {
    it('appends ref fragment when provided', () => {
      expect(formatSourceInput('https://github.com/owner/repo.git', 'feature/install')).toBe(
        'https://github.com/owner/repo.git#feature/install'
      );
    });

    it('returns source unchanged when ref is missing', () => {
      expect(formatSourceInput('https://github.com/owner/repo.git')).toBe(
        'https://github.com/owner/repo.git'
      );
    });
  });

  describe('buildUpdateInstallSource', () => {
    it('builds root-level install source without trailing slash', () => {
      const result = buildUpdateInstallSource({
        source: 'owner/repo',
        sourceUrl: 'https://github.com/owner/repo.git',
        ref: 'feature/install',
        skillPath: 'SKILL.md',
      });
      expect(result).toBe('owner/repo#feature/install');
    });

    it('builds nested skill install source with ref', () => {
      const result = buildUpdateInstallSource({
        source: 'owner/repo',
        sourceUrl: 'https://github.com/owner/repo.git',
        ref: 'feature/install',
        skillPath: 'skills/my-skill/SKILL.md',
      });
      expect(result).toBe('owner/repo/skills/my-skill#feature/install');
    });

    it('falls back to sourceUrl when skillPath is missing', () => {
      const result = buildUpdateInstallSource({
        source: 'owner/repo',
        sourceUrl: 'https://github.com/owner/repo.git',
        ref: 'feature/install',
      });
      expect(result).toBe('https://github.com/owner/repo.git#feature/install');
    });

    it('builds Hub install source with a skill filter', () => {
      const result = buildUpdateInstallSource(
        {
          source: 'owner/repo',
          sourceType: 'hub',
          sourceUrl: 'https://hub.example.com/openapi/v1/skills/owner/repo/skills/my-skill',
        },
        'my-skill'
      );
      expect(result).toBe('owner/repo@my-skill');
    });

    it('ignores legacy Hub refs when building skill update sources', () => {
      const result = buildUpdateInstallSource(
        {
          source: 'owner/repo',
          sourceType: 'hub',
          sourceUrl: 'https://hub.example.com/openapi/v1/skills/owner/repo/skills/my-skill',
          ref: 'feature/install',
        },
        'my-skill'
      );
      expect(result).toBe('owner/repo@my-skill');
    });
  });

  describe('buildLocalUpdateSource', () => {
    it('builds local Hub update source with a skill filter', () => {
      const result = buildLocalUpdateSource(
        {
          source: 'owner/repo',
          sourceType: 'hub',
        },
        'my-skill'
      );
      expect(result).toBe('owner/repo@my-skill');
    });

    it('preserves non-Hub local update source behavior', () => {
      const result = buildLocalUpdateSource(
        {
          source: 'owner/repo',
          sourceType: 'github',
          ref: 'main',
        },
        'ignored'
      );
      expect(result).toBe('owner/repo#main');
    });

    it('uses sourceUrl when a well-known local lock recorded the /openapi URL', () => {
      const result = buildLocalUpdateSource(
        {
          source: 'baizhicloud/foo',
          sourceUrl: 'https://hub.example.com/openapi/baizhicloud/foo',
          sourceType: 'well-known',
        },
        'ignored'
      );
      expect(result).toBe('https://hub.example.com/openapi/baizhicloud/foo');
    });
  });

  describe('hubEnvFromSourceUrl', () => {
    it('extracts SKILLS_HUB_URL from native Hub package URLs', () => {
      expect(hubEnvFromSourceUrl('https://hub.example.com/openapi/v1/skills/owner/repo')).toEqual({
        SKILLS_HUB_URL: 'https://hub.example.com',
      });
    });

    it('extracts SKILLS_HUB_URL from native Hub skill URLs', () => {
      expect(
        hubEnvFromSourceUrl('https://hub.example.com/openapi/v1/skills/owner/repo/skills/my-skill')
      ).toEqual({ SKILLS_HUB_URL: 'https://hub.example.com' });
    });

    it('ignores non-native Hub URLs', () => {
      expect(hubEnvFromSourceUrl('https://hub.example.com/owner/repo')).toEqual({});
    });
  });
});
