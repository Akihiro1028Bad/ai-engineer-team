import { z } from 'zod';
import { inputSchema, outputSchema } from './schema';
import * as fs from 'fs';
import * as path from 'path';

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

interface GitConfig {
  [key: string]: string;
}

interface PackageAuthor {
  name?: string;
  email?: string;
}

/**
 * Parse git config file
 */
function parseGitConfig(configPath: string): GitConfig {
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config: GitConfig = {};
    let currentSection = '';

    content.split('\n').forEach(line => {
      line = line.trim();
      
      // Section header
      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        return;
      }

      // Key-value pair
      const kvMatch = line.match(/^([^=]+)=(.+)$/);
      if (kvMatch && currentSection) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        config[`${currentSection}.${key}`] = value;
      }
    });

    return config;
  } catch (error) {
    return {};
  }
}

/**
 * Get git user info from .git/config
 */
function getGitUserInfo(workspaceRoot: string): { name?: string; email?: string } {
  const gitConfigPath = path.join(workspaceRoot, '.git', 'config');
  const config = parseGitConfig(gitConfigPath);

  return {
    name: config['user.name'],
    email: config['user.email']
  };
}

/**
 * Get global git config
 */
function getGlobalGitConfig(): { name?: string; email?: string } {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const globalConfigPath = path.join(homeDir, '.gitconfig');
  const config = parseGitConfig(globalConfigPath);

  return {
    name: config['user.name'],
    email: config['user.email']
  };
}

/**
 * Get author info from package.json
 */
function getPackageAuthorInfo(workspaceRoot: string): { name?: string; email?: string } {
  try {
    const packageJsonPath = path.join(workspaceRoot, 'package.json');
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content);
    
    if (typeof packageJson.author === 'string') {
      // Parse "Name <email>" format
      const match = packageJson.author.match(/^([^<]+)(?:<([^>]+)>)?$/);
      if (match) {
        return {
          name: match[1]?.trim(),
          email: match[2]?.trim()
        };
      }
    } else if (typeof packageJson.author === 'object') {
      return {
        name: packageJson.author.name,
        email: packageJson.author.email
      };
    }
  } catch (error) {
    // package.json not found or invalid
  }

  return {};
}

/**
 * Get reviewer info from environment variables
 */
function getEnvReviewerInfo(): { name?: string; email?: string } {
  return {
    name: process.env.GIT_AUTHOR_NAME || process.env.USER || process.env.USERNAME,
    email: process.env.GIT_AUTHOR_EMAIL || process.env.EMAIL
  };
}

export function handle(input: Input): Output {
  const workspaceRoot = input.workspaceRoot || process.cwd();
  const sources: string[] = [];
  let resolvedName: string | undefined;
  let resolvedEmail: string | undefined;

  // Priority 1: Explicit input
  if (input.name || input.email) {
    resolvedName = input.name;
    resolvedEmail = input.email;
    sources.push('explicit');
  }

  // Priority 2: Local git config
  if (!resolvedName || !resolvedEmail) {
    const gitInfo = getGitUserInfo(workspaceRoot);
    if (gitInfo.name && !resolvedName) {
      resolvedName = gitInfo.name;
      sources.push('git-local');
    }
    if (gitInfo.email && !resolvedEmail) {
      resolvedEmail = gitInfo.email;
      sources.push('git-local');
    }
  }

  // Priority 3: Global git config
  if (!resolvedName || !resolvedEmail) {
    const globalGitInfo = getGlobalGitConfig();
    if (globalGitInfo.name && !resolvedName) {
      resolvedName = globalGitInfo.name;
      sources.push('git-global');
    }
    if (globalGitInfo.email && !resolvedEmail) {
      resolvedEmail = globalGitInfo.email;
      sources.push('git-global');
    }
  }

  // Priority 4: package.json
  if (!resolvedName || !resolvedEmail) {
    const packageInfo = getPackageAuthorInfo(workspaceRoot);
    if (packageInfo.name && !resolvedName) {
      resolvedName = packageInfo.name;
      sources.push('package.json');
    }
    if (packageInfo.email && !resolvedEmail) {
      resolvedEmail = packageInfo.email;
      sources.push('package.json');
    }
  }

  // Priority 5: Environment variables
  if (!resolvedName || !resolvedEmail) {
    const envInfo = getEnvReviewerInfo();
    if (envInfo.name && !resolvedName) {
      resolvedName = envInfo.name;
      sources.push('environment');
    }
    if (envInfo.email && !resolvedEmail) {
      resolvedEmail = envInfo.email;
      sources.push('environment');
    }
  }

  // Format reviewer string
  let reviewer = 'unknown';
  if (resolvedName && resolvedEmail) {
    reviewer = `${resolvedName} <${resolvedEmail}>`;
  } else if (resolvedName) {
    reviewer = resolvedName;
  } else if (resolvedEmail) {
    reviewer = resolvedEmail;
  }

  return {
    reviewer,
    name: resolvedName,
    email: resolvedEmail,
    sources: Array.from(new Set(sources)),
    suggestions: reviewer === 'unknown' ? [
      'Set git user config: git config user.name "Your Name"',
      'Set git user email: git config user.email "your@email.com"',
      'Or set global config: git config --global user.name "Your Name"',
      'Add author field to package.json'
    ] : []
  };
}
