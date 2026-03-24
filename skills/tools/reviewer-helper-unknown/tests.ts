import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handle } from './handler';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');
vi.mock('path');

describe('reviewer-helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use explicit input when provided', () => {
    const result = handle({
      name: 'John Doe',
      email: 'john@example.com'
    });

    expect(result.reviewer).toBe('John Doe <john@example.com>');
    expect(result.name).toBe('John Doe');
    expect(result.email).toBe('john@example.com');
    expect(result.sources).toContain('explicit');
    expect(result.suggestions).toHaveLength(0);
  });

  it('should parse git config from local repository', () => {
    const mockGitConfig = `[core]
	repositoryformatversion = 0
[user]
	name = Jane Smith
	email = jane@example.com`;

    vi.mocked(fs.readFileSync).mockReturnValue(mockGitConfig);
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));

    const result = handle({ workspaceRoot: '/test/workspace' });

    expect(result.reviewer).toBe('Jane Smith <jane@example.com>');
    expect(result.name).toBe('Jane Smith');
    expect(result.email).toBe('jane@example.com');
    expect(result.sources).toContain('git-local');
  });

  it('should fall back to global git config', () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      if (filePath.includes('.git/config')) {
        throw new Error('Not found');
      }
      if (filePath.includes('.gitconfig')) {
        return `[user]
	name = Global User
	email = global@example.com`;
      }
      throw new Error('Not found');
    });
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));

    const result = handle({ workspaceRoot: '/test/workspace' });

    expect(result.reviewer).toBe('Global User <global@example.com>');
    expect(result.sources).toContain('git-global');
  });

  it('should parse author from package.json', () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      if (filePath.includes('package.json')) {
        return JSON.stringify({
          name: 'test-package',
          author: {
            name: 'Package Author',
            email: 'author@example.com'
          }
        });
      }
      throw new Error('Not found');
    });
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));

    const result = handle({ workspaceRoot: '/test/workspace' });

    expect(result.reviewer).toBe('Package Author <author@example.com>');
    expect(result.sources).toContain('package.json');
  });

  it('should return unknown with suggestions when no info found', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Not found');
    });
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));
    
    // Clear environment variables
    const oldEnv = { ...process.env };
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.USER;
    delete process.env.USERNAME;
    delete process.env.EMAIL;

    const result = handle({ workspaceRoot: '/test/workspace' });

    expect(result.reviewer).toBe('unknown');
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]).toContain('git config');

    // Restore environment
    process.env = oldEnv;
  });

  it('should handle string format author in package.json', () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      if (filePath.includes('package.json')) {
        return JSON.stringify({
          name: 'test-package',
          author: 'String Author <string@example.com>'
        });
      }
      throw new Error('Not found');
    });
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));

    const result = handle({ workspaceRoot: '/test/workspace' });

    expect(result.reviewer).toBe('String Author <string@example.com>');
    expect(result.name).toBe('String Author');
    expect(result.email).toBe('string@example.com');
  });

  it('should use environment variables as fallback', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Not found');
    });
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'));

    const oldEnv = { ...process.env };
    process.env.GIT_AUTHOR_NAME = 'Env User';
    process.env.GIT_AUTHOR_EMAIL = 'env@example.com';

    const result = handle({ workspaceRoot: '/test/workspace' });

    expect(result.reviewer).toBe('Env User <env@example.com>');
    expect(result.sources).toContain('environment');

    process.env = oldEnv;
  });
});
