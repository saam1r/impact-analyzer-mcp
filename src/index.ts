#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { simpleGit } from 'simple-git';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';

const git = simpleGit();

// Get repo root (walk up from cwd until we find .git)
async function findRepoRoot(): Promise<string> {
  try {
    const root = await git.revparse(['--show-toplevel']);
    return root.trim();
  } catch (error) {
    return process.cwd();
  }
}

// Get diff between branches
async function getDiff(base: string, head: string): Promise<string> {
  try {
    const diff = await git.diff([`${base}...${head}`]);
    // Limit to first 50KB to avoid token limits
    return diff.slice(0, 50000);
  } catch (error) {
    return `Error getting diff: ${error}`;
  }
}

// Get list of changed files with status
async function getChangedFiles(base: string, head: string) {
  try {
    const diff = await git.diffSummary([`${base}...${head}`]);
    return diff.files.map(file => ({
      path: file.file,
      status: file.binary ? 'B' : 'M',
      additions: 'insertions' in file ? file.insertions : 0,
      deletions: 'deletions' in file ? file.deletions : 0
    }));
  } catch (error) {
    return [];
  }
}

// Read file content
async function readFileContent(filePath: string, maxSize = 10000): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.slice(0, maxSize);
  } catch (error) {
    return '';
  }
}

// Recursively scan directory and list files
async function scanDirectory(dirPath: string, repoRoot: string): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subFiles = await scanDirectory(fullPath, repoRoot);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        // Add relative path from repo root
        const relativePath = relative(repoRoot, fullPath);
        files.push(relativePath);
      }
    }
  } catch (error) {
    // Directory doesn't exist or not readable
  }
  
  return files;
}

// Main analysis function
async function analyzePR(branch: string, base: string = 'main') {
  const repoRoot = await findRepoRoot();
  
  // Get git information
  const diff = await getDiff(base, branch);
  const changedFiles = await getChangedFiles(base, branch);
  
  // Read up to 10 changed files (for context)
  const fileContents: Record<string, string> = {};
  for (const file of changedFiles.slice(0, 10)) {
    const fullPath = join(repoRoot, file.path);
    fileContents[file.path] = await readFileContent(fullPath);
  }
  
  // Scan test directories
  const testDirs = [
    'tests/e2e/specs',
    'tests/e2e/api/api-specs',
    'tests/unit/backend',
    'tests/integration/backend'
  ];
  
  const testStructure: Record<string, string[]> = {};
  for (const dir of testDirs) {
    const fullPath = join(repoRoot, dir);
    testStructure[dir] = await scanDirectory(fullPath, repoRoot);
  }
  
  // Get commit messages
  let commitMessages: string[] = [];
  try {
    const log = await git.log([`${base}..${branch}`]);
    commitMessages = log.all.map(commit => commit.message).slice(0, 10);
  } catch (error) {
    commitMessages = [];
  }
  
  // Return structured data
  return {
    branch,
    base,
    summary: {
      filesChanged: changedFiles.length,
      filesAdded: changedFiles.filter(f => f.additions > 0 && f.deletions === 0).length,
      filesModified: changedFiles.filter(f => f.additions > 0 && f.deletions > 0).length,
      filesDeleted: changedFiles.filter(f => f.additions === 0 && f.deletions > 0).length,
      linesAdded: changedFiles.reduce((sum, f) => sum + f.additions, 0),
      linesDeleted: changedFiles.reduce((sum, f) => sum + f.deletions, 0)
    },
    changedFiles: changedFiles.map(f => `${f.status}\t${f.path}`).join('\n'),
    diff,
    fileContents,
    testStructure,
    commitMessages: commitMessages.join('\n')
  };
}

// Create MCP server
const server = new Server(
  {
    name: 'sprinto-impact-analyzer',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'analyze_pr',
      description: 'Analyze the impact of a PR or branch change. Returns git diff, changed files, file contents, and test directory structure.',
      inputSchema: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
            description: 'Branch name to analyze (e.g., "feature/new-feature")'
          },
          base: {
            type: 'string',
            description: 'Base branch to compare against'
          }
        },
        required: ['branch']
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'analyze_pr') {
    const { branch, base = 'main' } = request.params.arguments as { branch: string; base?: string };
    
    try {
      const result = await analyzePR(branch, base);
      
      // Format as readable text
      const output = `
Branch Analysis: ${branch} (base: ${base})

=== SUMMARY ===
Files Changed: ${result.summary.filesChanged}
Added: ${result.summary.filesAdded} | Modified: ${result.summary.filesModified} | Deleted: ${result.summary.filesDeleted}
Lines: +${result.summary.linesAdded} -${result.summary.linesDeleted}

=== CHANGED FILES ===
${result.changedFiles}

=== COMMIT MESSAGES ===
${result.commitMessages}

=== GIT DIFF (first 50KB) ===
${result.diff}

=== FILE CONTENTS (up to 10 files) ===
${Object.entries(result.fileContents).map(([path, content]) => 
  `\n--- ${path} ---\n${content}`
).join('\n')}

=== TEST STRUCTURE ===
${Object.entries(result.testStructure).map(([dir, files]) =>
  `\n${dir}/ (${files.length} files):\n${files.slice(0, 20).join('\n')}${files.length > 20 ? `\n... and ${files.length - 20} more` : ''}`
).join('\n')}
`;
      
      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Error analyzing PR: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  
  throw new McpError(
    ErrorCode.MethodNotFound,
    `Unknown tool: ${request.params.name}`
  );
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Sprinto Impact Analyzer MCP server running on stdio');
}

main().catch(console.error);
