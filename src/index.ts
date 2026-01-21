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
import { join, relative, dirname, extname, basename } from 'path';

const git = simpleGit();

// Environment variable configuration with defaults
const DEFAULT_BASE_BRANCH = process.env.DEFAULT_BASE_BRANCH || 'master';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '10000', 10);
const MAX_DIFF_SIZE = parseInt(process.env.MAX_DIFF_SIZE || '50000', 10);
const MAX_FILES_TO_READ = parseInt(process.env.MAX_FILES_TO_READ || '10', 10);
const MAX_COMMITS = parseInt(process.env.MAX_COMMITS || '10', 10);
const TEST_DIRECTORIES = process.env.TEST_DIRECTORIES 
  ? process.env.TEST_DIRECTORIES.split(',').map(d => d.trim())
  : ['tests/e2e/specs', 'tests/e2e/api/api-specs', 'tests/unit/backend', 'tests/integration/backend'];
const MAX_DEPENDENCY_DEPTH = parseInt(process.env.MAX_DEPENDENCY_DEPTH || '2', 10);

// Get repo root (walk up from cwd until we find .git)
async function findRepoRoot(): Promise<string> {
  try {
    const root = await git.revparse(['--show-toplevel']);
    return root.trim();
  } catch (error) {
    return process.cwd();
  }
}

// Ensure branch is available (fetch from remote if needed)
async function ensureBranchAvailable(branch: string): Promise<string> {
  try {
    // First, fetch the branch from origin to ensure we have latest
    await git.fetch(['origin', branch]);
  } catch (error) {
    // Branch might not exist on remote or already fetched, continue
  }
  
  // Check if local branch exists
  try {
    await git.revparse(['--verify', branch]);
    return branch;
  } catch (error) {
    // Local branch doesn't exist, try origin/branch
    try {
      await git.revparse(['--verify', `origin/${branch}`]);
      return `origin/${branch}`;
    } catch (error2) {
      // Return original, let it fail with better error
      return branch;
    }
  }
}

// Get diff between branches
async function getDiff(base: string, head: string): Promise<string> {
  try {
    // Ensure both branches are available
    const resolvedBase = await ensureBranchAvailable(base);
    const resolvedHead = await ensureBranchAvailable(head);
    
    const diff = await git.diff([`${resolvedBase}...${resolvedHead}`]);
    // Limit to MAX_DIFF_SIZE to avoid token limits
    return diff.slice(0, MAX_DIFF_SIZE);
  } catch (error) {
    return `Error getting diff: ${error}`;
  }
}

// Get list of changed files with status
async function getChangedFiles(base: string, head: string) {
  try {
    // Ensure both branches are available
    const resolvedBase = await ensureBranchAvailable(base);
    const resolvedHead = await ensureBranchAvailable(head);
    
    const diff = await git.diffSummary([`${resolvedBase}...${resolvedHead}`]);
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
async function readFileContent(filePath: string, maxSize: number = MAX_FILE_SIZE): Promise<string> {
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

// Get all source files in the repository (for dependency analysis)
async function getAllSourceFiles(repoRoot: string, extensions: string[] = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java']): Promise<string[]> {
  const files: string[] = [];
  const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache'];
  
  async function scanRecursive(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = relative(repoRoot, fullPath);
        
        // Skip ignored directories
        if (entry.isDirectory() && ignoreDirs.some(ignore => relativePath.includes(ignore))) {
          continue;
        }
        
        if (entry.isDirectory()) {
          await scanRecursive(fullPath);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (extensions.includes(ext) || extensions.length === 0) {
            files.push(relativePath);
          }
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }
  
  await scanRecursive(repoRoot);
  return files;
}

// Extract imports/exports from a file (supports JS/TS, Python, Go, Java)
async function extractImports(filePath: string, content: string): Promise<string[]> {
  const imports: string[] = [];
  const ext = extname(filePath);
  
  // JavaScript/TypeScript imports
  if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
    // ES6 imports: import ... from '...'
    const es6ImportRegex = /import\s+(?:.*\s+from\s+)?['"]([^'"]+)['"]/g;
    // require: require('...')
    const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
    // dynamic import: import('...')
    const dynamicImportRegex = /import\(['"]([^'"]+)['"]\)/g;
    
    let match;
    while ((match = es6ImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = requireRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
  }
  
  // Python imports
  if (ext === '.py') {
    const pythonImportRegex = /(?:from|import)\s+([\w.]+)/g;
    let match;
    while ((match = pythonImportRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
  }
  
  // Go imports
  if (ext === '.go') {
    const goImportRegex = /import\s+(?:\([\s\S]*?\)|['"]([^'"]+)['"])/g;
    let match;
    while ((match = goImportRegex.exec(content)) !== null) {
      if (match[1]) imports.push(match[1]);
    }
  }
  
  return imports;
}

// Resolve import path to actual file path
function resolveImportPath(importPath: string, fromFile: string, repoRoot: string): string | null {
  // Skip external packages (node_modules, etc.)
  if (importPath.startsWith('.') || importPath.startsWith('/')) {
    const fromDir = dirname(join(repoRoot, fromFile));
    const resolved = join(fromDir, importPath);
    
    // Try common extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.go'];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (candidate.startsWith(repoRoot)) {
        return relative(repoRoot, candidate);
      }
    }
    
    // Try index files
    for (const ext of extensions) {
      const candidate = join(resolved, `index${ext}`);
      if (candidate.startsWith(repoRoot)) {
        return relative(repoRoot, candidate);
      }
    }
  }
  
  return null;
}

// Find files that import/use the changed files (indirect dependencies)
async function findIndirectDependencies(changedFiles: Array<{ path: string }>, repoRoot: string): Promise<{
  direct: Record<string, string[]>;
  indirect: Record<string, string[]>;
  allAffected: string[];
}> {
  const directDeps: Record<string, string[]> = {};
  const indirectDeps: Record<string, string[]> = {};
  const allAffected = new Set<string>(changedFiles.map(f => f.path));
  
  // Get all source files
  const allFiles = await getAllSourceFiles(repoRoot);
  
  // Build dependency map: file -> files that import it
  const dependencyMap: Record<string, string[]> = {};
  
  for (const file of allFiles) {
    try {
      const content = await readFileContent(join(repoRoot, file), 50000);
      const imports = await extractImports(file, content);
      
      for (const imp of imports) {
        const resolved = resolveImportPath(imp, file, repoRoot);
        if (resolved && resolved !== file) {
          if (!dependencyMap[resolved]) {
            dependencyMap[resolved] = [];
          }
          dependencyMap[resolved].push(file);
        }
      }
    } catch (error) {
      // Skip files we can't read
    }
  }
  
  // Find direct dependencies (files that import changed files)
  for (const changedFile of changedFiles) {
    const dependents = dependencyMap[changedFile.path] || [];
    directDeps[changedFile.path] = dependents;
    dependents.forEach(dep => allAffected.add(dep));
  }
  
  // Find indirect dependencies (files that import direct dependencies)
  const processed = new Set<string>(changedFiles.map(f => f.path));
  
  function findIndirect(file: string, depth: number): void {
    if (depth > MAX_DEPENDENCY_DEPTH) return;
    if (processed.has(file)) return;
    
    processed.add(file);
    const dependents = dependencyMap[file] || [];
    
    if (dependents.length > 0) {
      if (!indirectDeps[file]) {
        indirectDeps[file] = [];
      }
      indirectDeps[file] = dependents;
      dependents.forEach(dep => {
        allAffected.add(dep);
        findIndirect(dep, depth + 1);
      });
    }
  }
  
  // Find indirect dependencies for each direct dependency
  for (const changedFile of changedFiles) {
    const direct = directDeps[changedFile.path] || [];
    for (const dep of direct) {
      findIndirect(dep, 1);
    }
  }
  
  return {
    direct: directDeps,
    indirect: indirectDeps,
    allAffected: Array.from(allAffected)
  };
}

// Find test files related to changed files
async function findRelatedTests(changedFiles: Array<{ path: string }>, repoRoot: string): Promise<{
  relatedTests: Array<{ testFile: string; relatedTo: string[]; confidence: 'high' | 'medium' | 'low' }>;
  testCoverage: { covered: number; total: number; percentage: number };
  missingTests: string[];
}> {
  const relatedTests: Array<{ testFile: string; relatedTo: string[]; confidence: 'high' | 'medium' | 'low' }> = [];
  const testFiles: string[] = [];
  
  // Collect all test files
  for (const testDir of TEST_DIRECTORIES) {
    const fullPath = join(repoRoot, testDir);
    const files = await scanDirectory(fullPath, repoRoot);
    testFiles.push(...files);
  }
  
  // Also search for test files near changed files
  for (const changedFile of changedFiles) {
    const fileDir = dirname(changedFile.path);
    const fileName = basename(changedFile.path, extname(changedFile.path));
    
    // Common test file patterns
    const testPatterns = [
      `${fileDir}/${fileName}.test`,
      `${fileDir}/${fileName}.spec`,
      `${fileDir}/__tests__/${fileName}`,
      `${fileDir}/test/${fileName}`,
      `${fileDir}/tests/${fileName}`,
    ];
    
    for (const pattern of testPatterns) {
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
      for (const ext of extensions) {
        const testFile = pattern + ext;
        if (testFiles.includes(testFile) || await fileExists(join(repoRoot, testFile))) {
          testFiles.push(testFile);
        }
      }
    }
  }
  
  // Find tests that reference changed files
  const changedFileNames = changedFiles.map(f => basename(f.path, extname(f.path)));
  const changedPaths = changedFiles.map(f => f.path);
  
  for (const testFile of testFiles) {
    try {
      const content = await readFileContent(join(repoRoot, testFile), 50000);
      const related: string[] = [];
      let confidence: 'high' | 'medium' | 'low' = 'low';
      
      // Check if test imports or references changed files
      const imports = await extractImports(testFile, content);
      for (const imp of imports) {
        const resolved = resolveImportPath(imp, testFile, repoRoot);
        if (resolved && changedPaths.includes(resolved)) {
          related.push(resolved);
          confidence = 'high';
        }
      }
      
      // Check if test file name matches changed file
      const testFileName = basename(testFile, extname(testFile));
      for (const changedFileName of changedFileNames) {
        if (testFileName.includes(changedFileName) || changedFileName.includes(testFileName)) {
          if (!related.some(r => changedPaths.includes(r))) {
            const matching = changedFiles.find(f => basename(f.path, extname(f.path)) === changedFileName);
            if (matching && !related.includes(matching.path)) {
              related.push(matching.path);
              if (confidence === 'low') confidence = 'medium';
            }
          }
        }
      }
      
      // Check if test content mentions changed files
      for (const changedPath of changedPaths) {
        const pathParts = changedPath.split('/');
        const fileName = pathParts[pathParts.length - 1];
        if (content.includes(fileName) && !related.includes(changedPath)) {
          related.push(changedPath);
          if (confidence === 'low') confidence = 'low';
        }
      }
      
      if (related.length > 0) {
        relatedTests.push({ testFile, relatedTo: related, confidence });
      }
    } catch (error) {
      // Skip test files we can't read
    }
  }
  
  // Find missing tests (changed files without related tests)
  const coveredFiles = new Set(relatedTests.flatMap(t => t.relatedTo));
  const missingTests = changedFiles
    .filter(f => !coveredFiles.has(f.path))
    .map(f => f.path);
  
  const testCoverage = {
    covered: coveredFiles.size,
    total: changedFiles.length,
    percentage: changedFiles.length > 0 ? Math.round((coveredFiles.size / changedFiles.length) * 100) : 100
  };
  
  return { relatedTests, testCoverage, missingTests };
}

// Check if file exists
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// Analyze indirect dependencies
async function analyzeIndirectDependencies(branch: string, base: string = DEFAULT_BASE_BRANCH) {
  const repoRoot = await findRepoRoot();
  const changedFiles = await getChangedFiles(base, branch);
  
  const dependencies = await findIndirectDependencies(changedFiles, repoRoot);
  
  return {
    branch,
    base,
    changedFiles: changedFiles.map(f => f.path),
    directDependencies: dependencies.direct,
    indirectDependencies: dependencies.indirect,
    allAffectedFiles: dependencies.allAffected,
    summary: {
      directlyChanged: changedFiles.length,
      directlyAffected: Object.values(dependencies.direct).flat().length,
      indirectlyAffected: Object.values(dependencies.indirect).flat().length,
      totalAffected: dependencies.allAffected.length
    }
  };
}

// Analyze test coverage
async function analyzeTestCoverage(branch: string, base: string = DEFAULT_BASE_BRANCH) {
  const repoRoot = await findRepoRoot();
  const changedFiles = await getChangedFiles(base, branch);
  
  const testAnalysis = await findRelatedTests(changedFiles, repoRoot);
  
  return {
    branch,
    base,
    changedFiles: changedFiles.map(f => f.path),
    testCoverage: testAnalysis.testCoverage,
    relatedTests: testAnalysis.relatedTests,
    missingTests: testAnalysis.missingTests,
    summary: {
      filesChanged: changedFiles.length,
      testsFound: testAnalysis.relatedTests.length,
      coveragePercentage: testAnalysis.testCoverage.percentage,
      filesWithoutTests: testAnalysis.missingTests.length
    }
  };
}

// Analyze diff content for specific code patterns that often cause bugs
function analyzeDiffPatterns(diff: string): {
  apiResponseChanges: string[];
  potentialUndefinedIssues: string[];
  changedFunctionNames: string[];
  returnStatementChanges: string[];
} {
  const patterns = {
    apiResponseChanges: [] as string[],
    potentialUndefinedIssues: [] as string[],
    changedFunctionNames: [] as string[],
    returnStatementChanges: [] as string[]
  };
  
  const lines = diff.split('\n');
  let currentFile = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Track current file
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) currentFile = match[1];
    }
    
    // Detect added lines (new code)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const code = line.substring(1);
      
      // Pattern 1: Arrays with potentially undefined values
      // e.g., errors: [{ messages: response.err }] where response.err could be undefined
      const undefinedArrayPattern = /\[\s*\{\s*\w+:\s*\w+\.(\w+)\s*\}\s*\]/;
      const undefinedMatch = code.match(undefinedArrayPattern);
      if (undefinedMatch) {
        const propName = undefinedMatch[1];
        // Common optional property names
        if (['err', 'error', 'message', 'data', 'result', 'value'].includes(propName.toLowerCase())) {
          patterns.potentialUndefinedIssues.push(
            `${basename(currentFile)}: [{ key: obj.${propName} }] - If ${propName} is undefined, array is still truthy [{ key: undefined }]`
          );
        }
      }
      
      // Pattern 2: Return statement changes with object restructuring
      if (code.includes('return {') || code.includes('return{')) {
        // Check if this is a response format
        if (code.includes('success') || code.includes('error') || code.includes('data')) {
          patterns.returnStatementChanges.push(`${basename(currentFile)}: Return format changed - verify all callers handle new format`);
        }
      }
      
      // Pattern 3: API response format changes
      if ((code.includes('success:') || code.includes('errors:') || code.includes('data:')) && 
          (code.includes('return') || code.includes('=>'))) {
        patterns.apiResponseChanges.push(`${basename(currentFile)}: API response shape changed`);
      }
    }
    
    // Detect removed lines that had different return format
    if (line.startsWith('-') && !line.startsWith('---')) {
      const code = line.substring(1);
      if (code.includes('return {') && (code.includes('success') || code.includes('data'))) {
        // Check if next few lines have a different return format (added)
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (lines[j].startsWith('+') && lines[j].includes('return {')) {
            patterns.apiResponseChanges.push(`${basename(currentFile)}: Return statement CHANGED - old format removed, new format added. Check ALL callers!`);
            break;
          }
        }
      }
    }
    
    // Detect changed function definitions
    const funcDefPattern = /^[+-]\s*(async\s+)?(function\s+(\w+)|const\s+(\w+)\s*=|(\w+)\s*[=:]\s*(async\s+)?\(|(\w+)\s*\([^)]*\)\s*{)/;
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      const match = line.match(funcDefPattern);
      if (match) {
        const funcName = match[3] || match[4] || match[5] || match[7];
        if (funcName && !patterns.changedFunctionNames.includes(funcName)) {
          patterns.changedFunctionNames.push(funcName);
        }
      }
    }
  }
  
  // Deduplicate
  patterns.apiResponseChanges = [...new Set(patterns.apiResponseChanges)];
  patterns.potentialUndefinedIssues = [...new Set(patterns.potentialUndefinedIssues)];
  patterns.returnStatementChanges = [...new Set(patterns.returnStatementChanges)];
  
  return patterns;
}

// Analyze risks and potential issues in the changes
function analyzeRisksAndImpact(
  changedFiles: Array<{ path: string; status: string; additions: number; deletions: number }>, 
  testAnalysis: { relatedTests: any[]; missingTests: string[]; testCoverage: any },
  dependencies: { direct: Record<string, string[]>; indirect: Record<string, string[]>; allAffected: string[] },
  diffContent: string = ''
): {
  riskLevel: 'Low' | 'Medium' | 'High' | 'Critical';
  breakingChanges: string[];
  regressionRisks: string[];
  performanceConcerns: string[];
  securityConcerns: string[];
  dataIntegrityRisks: string[];
  areasAffected: string[];
  criticalFilesToTest: string[];
  missedConsiderations: string[];
  affectedByFile: Record<string, string[]>;
  codePatternWarnings: string[];
} {
  const risks = {
    riskLevel: 'Low' as 'Low' | 'Medium' | 'High' | 'Critical',
    breakingChanges: [] as string[],
    regressionRisks: [] as string[],
    performanceConcerns: [] as string[],
    securityConcerns: [] as string[],
    dataIntegrityRisks: [] as string[],
    areasAffected: [] as string[],
    criticalFilesToTest: [] as string[],
    missedConsiderations: [] as string[],
    affectedByFile: {} as Record<string, string[]>,
    codePatternWarnings: [] as string[]
  };
  
  // Analyze diff for specific bug patterns
  const diffPatterns = analyzeDiffPatterns(diffContent);
  
  // Add code pattern warnings
  if (diffPatterns.potentialUndefinedIssues.length > 0) {
    risks.codePatternWarnings.push('⚠️ POTENTIAL UNDEFINED/NULL ISSUES:');
    diffPatterns.potentialUndefinedIssues.forEach(issue => {
      risks.codePatternWarnings.push(`   • ${issue}`);
      risks.codePatternWarnings.push(`     ↳ ASK: "What happens when this value is undefined? Will downstream code interpret it correctly?"`);
    });
  }
  
  if (diffPatterns.apiResponseChanges.length > 0) {
    risks.codePatternWarnings.push('⚠️ API RESPONSE FORMAT CHANGED:');
    diffPatterns.apiResponseChanges.forEach(change => {
      risks.codePatternWarnings.push(`   • ${change}`);
    });
    risks.codePatternWarnings.push(`     ↳ HOW TO VERIFY: Search for ALL callers of this function (grep -r "functionName" src/), not just modified files`);
    risks.codePatternWarnings.push(`     ↳ ASK: "Are there any other callers (sync jobs, background tasks, other services) that weren't updated?"`);
  }
  
  if (diffPatterns.changedFunctionNames.length > 0) {
    risks.codePatternWarnings.push('📍 CHANGED FUNCTIONS - Find ALL callers:');
    diffPatterns.changedFunctionNames.slice(0, 5).forEach(funcName => {
      risks.codePatternWarnings.push(`   • ${funcName}() → Run: grep -r "${funcName}" src/`);
    });
    if (diffPatterns.changedFunctionNames.length > 5) {
      risks.codePatternWarnings.push(`   • ... and ${diffPatterns.changedFunctionNames.length - 5} more functions`);
    }
  }
  
  // Store which files are affected by each changed file
  risks.affectedByFile = dependencies.direct;
  
  // Detect file types and patterns
  const hasSchemaChanges = changedFiles.some(f => 
    f.path.includes('schema.graphql') || 
    f.path.includes('schema.gql') ||
    f.path.includes('.graphql')
  );
  
  const hasDBChanges = changedFiles.some(f => 
    f.path.includes('/migrations/') || 
    f.path.includes('/models/') ||
    f.path.toLowerCase().includes('model.js') ||
    f.path.toLowerCase().includes('module.js')
  );
  
  const hasAuthChanges = changedFiles.some(f => 
    f.path.toLowerCase().includes('auth') ||
    f.path.toLowerCase().includes('permission') ||
    f.path.toLowerCase().includes('role')
  );
  
  const hasAPIChanges = changedFiles.some(f => 
    f.path.includes('/api/') || 
    f.path.includes('.gql.js') ||
    f.path.includes('/graphql/')
  );
  
  const hasUIComponents = changedFiles.some(f => 
    f.path.includes('/components/') || 
    f.path.includes('/pages/') ||
    f.path.endsWith('.jsx') || 
    f.path.endsWith('.tsx')
  );
  
  const hasStateManagement = changedFiles.some(f =>
    f.path.includes('redux') ||
    f.path.includes('store') ||
    f.path.includes('context')
  );
  
  const hasUtilityChanges = changedFiles.some(f =>
    f.path.includes('/utils/') ||
    f.path.includes('/helpers/')
  );
  
  const hasConfigChanges = changedFiles.some(f => 
    f.path.includes('package.json') || 
    f.path.includes('.env') ||
    f.path.includes('config.')
  );
  
  const isLargeChange = changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0) > 200;
  const hasMultipleFiles = changedFiles.length > 5;
  const hasFilesDeletion = changedFiles.some(f => f.deletions > f.additions && f.deletions > 50);
  
  // Determine risk level
  let riskScore = 0;
  if (hasSchemaChanges) riskScore += 3;
  if (hasDBChanges) riskScore += 4;
  if (hasAuthChanges) riskScore += 4;
  if (hasAPIChanges) riskScore += 2;
  if (isLargeChange) riskScore += 2;
  if (hasMultipleFiles) riskScore += 1;
  if (testAnalysis.testCoverage.percentage < 50) riskScore += 3;
  if (hasFilesDeletion) riskScore += 2;
  
  if (riskScore >= 10) risks.riskLevel = 'Critical';
  else if (riskScore >= 6) risks.riskLevel = 'High';
  else if (riskScore >= 3) risks.riskLevel = 'Medium';
  else risks.riskLevel = 'Low';
  
  // Identify areas affected
  if (hasUIComponents) risks.areasAffected.push('Frontend UI');
  if (hasAPIChanges) risks.areasAffected.push('Backend API');
  if (hasDBChanges) risks.areasAffected.push('Database Layer');
  if (hasAuthChanges) risks.areasAffected.push('Authentication/Authorization');
  if (hasStateManagement) risks.areasAffected.push('State Management');
  
  // Helper to generate test suggestion based on file name
  const getTestSuggestion = (filePath: string): string => {
    const fileName = basename(filePath).toLowerCase();
    const dirPath = filePath.toLowerCase();
    
    // Page components
    if (fileName.includes('page')) {
      const pageName = basename(filePath).replace(/Page\.(js|jsx|tsx|ts)$/i, '').replace(/([A-Z])/g, ' $1').trim();
      return `Open ${pageName} page and test the main user flow`;
    }
    // Drawer components
    if (fileName.includes('drawer')) {
      return `Open the drawer and verify it displays correctly`;
    }
    // Table/List components
    if (fileName.includes('table') || fileName.includes('list') || fileName.includes('config')) {
      return `Verify table/list displays data correctly with sorting/filtering`;
    }
    // Form components
    if (fileName.includes('form')) {
      return `Test form submission with valid and invalid data`;
    }
    // Modal/Dialog
    if (fileName.includes('modal') || fileName.includes('dialog')) {
      return `Open modal, verify content, test close actions`;
    }
    // GraphQL queries
    if (dirPath.includes('.gql') || dirPath.includes('graphql') || dirPath.includes('queries')) {
      return `Test the GraphQL query in Playground, verify response format`;
    }
    // Backend modules
    if (dirPath.includes('module') || dirPath.includes('service')) {
      return `Test API endpoint with various inputs, check response`;
    }
    // Utils/Helpers
    if (dirPath.includes('utils') || dirPath.includes('helper') || dirPath.includes('shared')) {
      return `Verify all consuming components still work correctly`;
    }
    // Default
    return `Verify feature works as expected`;
  };
  
  // Breaking changes potential - BE SPECIFIC with HOW TO TEST
  if (hasSchemaChanges) {
    const schemaFiles = changedFiles.filter(f => f.path.includes('schema')).map(f => f.path);
    const schemaConsumers = schemaFiles.flatMap(f => dependencies.direct[f] || []);
    if (schemaConsumers.length > 0) {
      const consumerNames = schemaConsumers.slice(0, 3).map(f => basename(f));
      risks.breakingChanges.push(`schema.graphql changed → Used by: ${consumerNames.join(', ')}`);
      risks.breakingChanges.push(`  ↳ HOW TO TEST: Run GraphQL query in Playground, then test ${consumerNames[0]} to verify data loads`);
    } else {
      risks.breakingChanges.push(`schema.graphql changed → Check frontend queries that use modified types`);
      risks.breakingChanges.push(`  ↳ HOW TO TEST: Open GraphQL Playground, run affected queries, verify response format`);
    }
    risks.criticalFilesToTest.push(...schemaFiles);
    risks.criticalFilesToTest.push(...schemaConsumers.slice(0, 5));
  }
  
  if (hasAPIChanges) {
    const apiFiles = changedFiles.filter(f => f.path.includes('.gql.js') || f.path.includes('/api/')).map(f => f.path);
    apiFiles.forEach(apiFile => {
      const consumers = dependencies.direct[apiFile] || [];
      const apiName = basename(apiFile);
      if (consumers.length > 0) {
        const consumerNames = consumers.slice(0, 3).map(f => basename(f));
        risks.breakingChanges.push(`${apiName} changed → Used by: ${consumerNames.join(', ')}`);
        risks.breakingChanges.push(`  ↳ HOW TO TEST: ${getTestSuggestion(consumers[0])}`);
        risks.criticalFilesToTest.push(...consumers.slice(0, 3));
      } else {
        risks.breakingChanges.push(`${apiName} changed → Verify frontend calls to this query`);
        risks.breakingChanges.push(`  ↳ HOW TO TEST: Find where this query is used, test that feature`);
      }
    });
    risks.criticalFilesToTest.push(...apiFiles);
  }
  
  if (hasFilesDeletion) {
    const deletedFiles = changedFiles.filter(f => f.deletions > f.additions && f.deletions > 50);
    deletedFiles.forEach(f => {
      risks.breakingChanges.push(`Large deletion in ${basename(f.path)} (-${f.deletions} lines)`);
      risks.breakingChanges.push(`  ↳ HOW TO TEST: Search codebase for imports of deleted functions, test those features`);
    });
  }
  
  // Regression risks - BE SPECIFIC with HOW TO TEST
  if (hasUtilityChanges) {
    const utilFiles = changedFiles.filter(f => f.path.includes('/utils/') || f.path.includes('/helpers/') || f.path.includes('/shared/')).map(f => f.path);
    utilFiles.forEach(utilFile => {
      const consumers = dependencies.direct[utilFile] || [];
      const utilName = basename(utilFile);
      if (consumers.length > 0) {
        const consumerNames = consumers.slice(0, 4).map(f => basename(f));
        risks.regressionRisks.push(`${utilName} changed → Used by: ${consumerNames.join(', ')}${consumers.length > 4 ? ` (+${consumers.length - 4} more)` : ''}`);
        // Add specific test suggestion for first consumer
        risks.regressionRisks.push(`  ↳ HOW TO TEST: ${getTestSuggestion(consumers[0])}`);
        risks.criticalFilesToTest.push(...consumers.slice(0, 4));
      } else {
        risks.regressionRisks.push(`${utilName} changed → Check where this utility is imported`);
        risks.regressionRisks.push(`  ↳ HOW TO TEST: Search for "${utilName.replace(/\.(js|ts|jsx|tsx)$/, '')}" in codebase, test those features`);
      }
    });
    risks.criticalFilesToTest.push(...utilFiles);
  }
  
  if (hasStateManagement) {
    const stateFiles = changedFiles.filter(f => f.path.includes('redux') || f.path.includes('store') || f.path.includes('context')).map(f => f.path);
    stateFiles.forEach(stateFile => {
      const consumers = dependencies.direct[stateFile] || [];
      if (consumers.length > 0) {
        const consumerNames = consumers.slice(0, 4).map(f => basename(f));
        risks.regressionRisks.push(`${basename(stateFile)} changed → Components using this state: ${consumerNames.join(', ')}`);
        risks.regressionRisks.push(`  ↳ HOW TO TEST: Navigate to each component, verify data displays and updates correctly`);
      }
    });
  }
  
  if (hasUIComponents && hasMultipleFiles) {
    const componentFiles = changedFiles.filter(f => f.path.includes('/components/')).map(f => f.path);
    const componentNames = componentFiles.slice(0, 5).map(f => basename(f));
    risks.regressionRisks.push(`Multiple UI changes: ${componentNames.join(', ')}${componentFiles.length > 5 ? ` (+${componentFiles.length - 5} more)` : ''}`);
    risks.regressionRisks.push(`  ↳ HOW TO TEST: Test the feature that uses these components end-to-end`);
  }
  
  if (testAnalysis.missingTests.length > 0) {
    const filesWithoutTests = testAnalysis.missingTests.slice(0, 3).map(f => basename(f));
    risks.regressionRisks.push(`No tests for: ${filesWithoutTests.join(', ')}${testAnalysis.missingTests.length > 3 ? ` (+${testAnalysis.missingTests.length - 3} more)` : ''}`);
    risks.regressionRisks.push(`  ↳ HOW TO TEST: Manually test these files thoroughly before merge, or add unit tests`);
  }
  
  // Performance concerns - BE SPECIFIC with HOW TO TEST
  if (hasDBChanges) {
    const dbFiles = changedFiles.filter(f => f.path.includes('/models/') || f.path.includes('module.js') || f.path.includes('Module.js'));
    dbFiles.forEach(f => {
      risks.performanceConcerns.push(`${basename(f.path)} has DB changes`);
      risks.performanceConcerns.push(`  ↳ HOW TO TEST: Create 1000+ test records, trigger the query, check Network tab for response time (<500ms ideal)`);
    });
  }
  
  const jsonbFiles = changedFiles.filter(f => f.path.includes('module.js') || f.path.includes('gql.js'));
  if (jsonbFiles.length > 0) {
    risks.performanceConcerns.push(`JSONB/DB queries in ${jsonbFiles.map(f => basename(f.path)).join(', ')}`);
    risks.performanceConcerns.push(`  ↳ HOW TO TEST: Test search/filter with large dataset, if slow consider adding GIN index`);
  }
  
  // Security concerns - BE SPECIFIC with HOW TO TEST
  if (hasAuthChanges) {
    const authFiles = changedFiles.filter(f => f.path.toLowerCase().includes('auth') || f.path.toLowerCase().includes('permission'));
    authFiles.forEach(f => {
      risks.securityConcerns.push(`${basename(f.path)} changed (auth/permission)`);
      risks.securityConcerns.push(`  ↳ HOW TO TEST: Login as admin → test feature, then login as regular user → verify access is restricted, then try as guest`);
    });
    risks.criticalFilesToTest.push(...authFiles.map(f => f.path));
  }
  
  const inputFiles = changedFiles.filter(f => 
    f.path.includes('search') || f.path.includes('Search') ||
    f.path.includes('form') || f.path.includes('Form') ||
    f.path.includes('input') || f.path.includes('Input')
  );
  
  if (inputFiles.length > 0) {
    risks.securityConcerns.push(`User input in ${inputFiles.map(f => basename(f.path)).join(', ')}`);
    risks.securityConcerns.push(`  ↳ HOW TO TEST: Enter "'; DROP TABLE--" in input field (SQL injection), enter "<script>alert('x')</script>" (XSS), verify no errors and input is escaped`);
  } else if (hasAPIChanges || hasDBChanges) {
    risks.securityConcerns.push(`API/DB changes detected`);
    risks.securityConcerns.push(`  ↳ HOW TO TEST: Find any input field that sends data to changed API, test with "'; DROP TABLE--"`);
  }
  
  // Data integrity risks - BE SPECIFIC with HOW TO TEST
  if (hasDBChanges) {
    const moduleFiles = changedFiles.filter(f => f.path.includes('module.js') || f.path.includes('Module.js'));
    if (moduleFiles.length > 0) {
      risks.dataIntegrityRisks.push(`DB logic in ${moduleFiles.map(f => basename(f.path)).join(', ')}`);
      risks.dataIntegrityRisks.push(`  ↳ HOW TO TEST: Submit form with empty fields, with special chars (!@#$%^&*), with very long text (500+ chars)`);
    }
  }
  
  const transformFiles = changedFiles.filter(f =>
    f.path.includes('transform') || f.path.includes('Transform') ||
    f.path.includes('utils') || f.path.includes('Utils')
  );
  
  if (transformFiles.length > 0 && !hasUtilityChanges) {
    risks.dataIntegrityRisks.push(`Data transformation in ${transformFiles.map(f => basename(f.path)).join(', ')}`);
    risks.dataIntegrityRisks.push(`  ↳ HOW TO TEST: Check that output data format hasn't changed, compare before/after screenshots`);
  }
  
  // Missed considerations - BE SPECIFIC
  if (hasConfigChanges) {
    const configFiles = changedFiles.filter(f => f.path.includes('config') || f.path.includes('.env') || f.path.includes('package.json'));
    risks.missedConsiderations.push(`Config changed (${configFiles.map(f => basename(f.path)).join(', ')}) → Update .env.example and notify team`);
  }
  
  if (hasSchemaChanges && !changedFiles.some(f => f.path.includes('test'))) {
    risks.missedConsiderations.push(`schema.graphql changed but no test file updated → Add/update GraphQL tests`);
  }
  
  const pageFiles = changedFiles.filter(f => f.path.includes('Page.js') || f.path.includes('Page.tsx'));
  if (pageFiles.length > 0) {
    risks.missedConsiderations.push(`${pageFiles.map(f => basename(f.path)).join(', ')} → If using debounce/timers, verify cleanup on unmount`);
  }
  
  // Only add browser testing reminder for specific UI changes, not generically
  const uiComponentFiles = changedFiles.filter(f => f.path.includes('/components/') && (f.path.endsWith('.js') || f.path.endsWith('.jsx') || f.path.endsWith('.tsx')));
  if (uiComponentFiles.length > 0) {
    risks.missedConsiderations.push(`UI changes in ${uiComponentFiles.slice(0, 3).map(f => basename(f.path)).join(', ')} → Test Chrome, Safari, Firefox + mobile`);
  }
  
  if (testAnalysis.testCoverage.percentage < 70 && testAnalysis.missingTests.length > 0) {
    risks.missedConsiderations.push(`Test coverage ${testAnalysis.testCoverage.percentage}% → Add tests for ${testAnalysis.missingTests.slice(0, 2).map(f => basename(f)).join(', ')}`);
  }
  
  return risks;
}

// Generate developer action items based on change analysis
function generateDeveloperActionItems(changedFiles: Array<{ path: string; status: string; additions: number; deletions: number }>, testAnalysis: { relatedTests: any[]; missingTests: string[]; testCoverage: any }): {
  prDescriptionChecklist: string;
  detailedActionItems: Array<{ category: string; items: string[]; priority: 'high' | 'medium' | 'low' }>;
} {
  const actionItems: Array<{ category: string; items: string[]; priority: 'high' | 'medium' | 'low' }> = [];
  const prChecklistItems: string[] = [];
  
  // Detect file types and patterns
  const hasUIComponents = changedFiles.some(f => 
    f.path.includes('/components/') || 
    f.path.includes('/pages/') || 
    f.path.includes('.jsx') || 
    f.path.includes('.tsx') ||
    f.path.includes('/ui/')
  );
  
  const hasBackendChanges = changedFiles.some(f => 
    f.path.includes('/api/') || 
    f.path.includes('/services/') || 
    f.path.includes('/controllers/') ||
    f.path.includes('/models/')
  );
  
  const hasDBChanges = changedFiles.some(f => 
    f.path.includes('/migrations/') || 
    f.path.includes('/schema') ||
    f.path.includes('model')
  );
  
  const hasConfigChanges = changedFiles.some(f => 
    f.path.includes('package.json') || 
    f.path.includes('.env') ||
    f.path.includes('config')
  );
  
  const isLargeChange = changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0) > 100;
  const hasMultipleFiles = changedFiles.length > 3;
  
  // Code Quality & Testing (High Priority)
  const testingItems: string[] = [];
  if (testAnalysis.missingTests.length > 0) {
    testingItems.push(`Add tests for ${testAnalysis.missingTests.length} file(s) without test coverage`);
    prChecklistItems.push('[ ] Added/updated tests for changed functionality');
  } else {
    prChecklistItems.push('[x] Added/updated tests for changed functionality');
  }
  
  if (testAnalysis.testCoverage.percentage < 80) {
    testingItems.push('Improve test coverage - currently at ' + testAnalysis.testCoverage.percentage + '%');
  }
  
  testingItems.push('Run all related tests locally and verify they pass');
  testingItems.push('Check for any flaky tests and fix them');
  prChecklistItems.push('[ ] All existing tests pass locally');
  
  if (testingItems.length > 0) {
    actionItems.push({
      category: 'Testing & Quality Assurance',
      items: testingItems,
      priority: 'high'
    });
  }
  
  // UI/UX Verification (High Priority if UI changes)
  if (hasUIComponents) {
    const uiItems = [
      'Test UI changes across different browsers (Chrome, Firefox, Safari)',
      'Verify responsive design on mobile, tablet, and desktop viewports',
      'Check for visual regressions - compare screenshots before/after',
      'Verify accessibility (keyboard navigation, screen reader compatibility)',
      'Test with different user roles and permissions',
      'Check loading states and error handling in the UI'
    ];
    actionItems.push({
      category: 'UI/UX Verification',
      items: uiItems,
      priority: 'high'
    });
    prChecklistItems.push('[ ] Tested UI changes in multiple browsers');
    prChecklistItems.push('[ ] Verified responsive design on different screen sizes');
    prChecklistItems.push('[ ] Checked accessibility compliance');
  }
  
  // Backend & API Verification (High Priority if backend changes)
  if (hasBackendChanges) {
    const backendItems = [
      'Test API endpoints manually using Postman/GraphQL playground',
      'Verify error handling for edge cases and invalid inputs',
      'Check API response formats and status codes',
      'Verify authentication and authorization logic',
      'Test with different user permissions and roles',
      'Check for proper logging and error messages'
    ];
    actionItems.push({
      category: 'Backend & API Verification',
      items: backendItems,
      priority: 'high'
    });
    prChecklistItems.push('[ ] Tested API endpoints manually');
    prChecklistItems.push('[ ] Verified error handling and edge cases');
  }
  
  // Database & Data Integrity (High Priority if DB changes)
  if (hasDBChanges) {
    const dbItems = [
      'Review and test database migrations (up and down)',
      'Verify data integrity and constraints',
      'Check for proper indexing on new columns',
      'Test rollback scenario',
      'Verify migration runs successfully on staging',
      'Document any manual data migration steps'
    ];
    actionItems.push({
      category: 'Database & Data Integrity',
      items: dbItems,
      priority: 'high'
    });
    prChecklistItems.push('[ ] Tested database migrations');
    prChecklistItems.push('[ ] Verified data integrity');
  }
  
  // Code Review Preparation (Medium Priority)
  const codeReviewItems = [
    'Remove any console.logs, debugger statements, or commented code',
    'Ensure code follows project coding standards and conventions',
    'Add inline comments for complex logic',
    'Update relevant documentation (README, API docs, etc.)',
    'Check for any hardcoded values that should be environment variables',
    'Verify no sensitive data (API keys, passwords) is committed'
  ];
  actionItems.push({
    category: 'Code Review Preparation',
    items: codeReviewItems,
    priority: 'medium'
  });
  prChecklistItems.push('[ ] Removed debug code and console logs');
  prChecklistItems.push('[ ] Code follows project conventions');
  prChecklistItems.push('[ ] No sensitive data in code');
  
  // Configuration & Dependencies (High Priority if config changes)
  if (hasConfigChanges) {
    const configItems = [
      'Update environment variable documentation',
      'Verify new dependencies are necessary and secure',
      'Check for dependency version conflicts',
      'Update .env.example with new required variables',
      'Document any new configuration steps for team'
    ];
    actionItems.push({
      category: 'Configuration & Dependencies',
      items: configItems,
      priority: 'high'
    });
    prChecklistItems.push('[ ] Updated configuration documentation');
  }
  
  // Performance & Security (Medium Priority for large changes)
  if (isLargeChange || hasMultipleFiles) {
    const perfItems = [
      'Profile performance impact of changes',
      'Check for memory leaks or performance bottlenecks',
      'Verify security implications of changes',
      'Review for potential SQL injection or XSS vulnerabilities',
      'Check for proper input validation and sanitization'
    ];
    actionItems.push({
      category: 'Performance & Security',
      items: perfItems,
      priority: 'medium'
    });
    prChecklistItems.push('[ ] Reviewed security implications');
    prChecklistItems.push('[ ] Checked performance impact');
  }
  
  // Integration & End-to-End Testing (Medium Priority)
  const integrationItems = [
    'Test the complete user flow end-to-end',
    'Verify integration with dependent services/systems',
    'Test with realistic data volumes',
    'Check for race conditions or timing issues',
    'Verify error messages are user-friendly'
  ];
  actionItems.push({
    category: 'Integration Testing',
    items: integrationItems,
    priority: 'medium'
  });
  prChecklistItems.push('[ ] Tested complete user flows');
  
  // Documentation (Low Priority but important)
  const docItems = [
    'Update CHANGELOG if applicable',
    'Add JSDoc/docstrings for new functions',
    'Update relevant Confluence/Wiki pages',
    'Add inline comments for complex logic',
    'Update API documentation if endpoints changed'
  ];
  actionItems.push({
    category: 'Documentation',
    items: docItems,
    priority: 'low'
  });
  prChecklistItems.push('[ ] Updated relevant documentation');
  
  // Pre-Merge Checklist (High Priority)
  const preMergeItems = [
    'Rebase/merge latest changes from base branch',
    'Resolve any merge conflicts',
    'Verify CI/CD pipeline passes',
    'Get required approvals from code reviewers',
    'Address all review comments',
    'Squash commits if needed (follow team conventions)'
  ];
  actionItems.push({
    category: 'Pre-Merge Checklist',
    items: preMergeItems,
    priority: 'high'
  });
  prChecklistItems.push('[ ] Rebased with latest base branch');
  prChecklistItems.push('[ ] CI/CD pipeline passing');
  prChecklistItems.push('[ ] All review comments addressed');
  
  // Format PR description checklist
  const prDescriptionChecklist = `
## Developer Checklist

**Before requesting review:**
${prChecklistItems.map(item => item).join('\n')}

**Testing Completed:**
- [ ] Manual testing completed
- [ ] Edge cases tested
- [ ] Error scenarios tested
- [ ] Tested with different user roles/permissions

**Code Quality:**
- [ ] No linter errors or warnings
- [ ] Code is self-documenting or well-commented
- [ ] Follows DRY (Don't Repeat Yourself) principle

**Sign-off:**
- [ ] I have tested these changes thoroughly
- [ ] I have reviewed my own code
- [ ] I am confident this is ready for production

---
**Additional Context:**
<!-- Add any additional notes, screenshots, or context for reviewers -->
`.trim();
  
  return {
    prDescriptionChecklist,
    detailedActionItems: actionItems
  };
}

// Main analysis function
async function analyzePR(branch: string, base: string = DEFAULT_BASE_BRANCH) {
  const repoRoot = await findRepoRoot();
  
  // Get git information
  const diff = await getDiff(base, branch);
  const changedFiles = await getChangedFiles(base, branch);
  
  // Read up to MAX_FILES_TO_READ changed files (for context)
  const fileContents: Record<string, string> = {};
  for (const file of changedFiles.slice(0, MAX_FILES_TO_READ)) {
    const fullPath = join(repoRoot, file.path);
    fileContents[file.path] = await readFileContent(fullPath);
  }
  
  // Scan test directories (from env or default)
  const testStructure: Record<string, string[]> = {};
  for (const dir of TEST_DIRECTORIES) {
    const fullPath = join(repoRoot, dir);
    testStructure[dir] = await scanDirectory(fullPath, repoRoot);
  }
  
  // Get commit messages
  let commitMessages: string[] = [];
  try {
    const log = await git.log([`${base}..${branch}`]);
    commitMessages = log.all.map(commit => commit.message).slice(0, MAX_COMMITS);
  } catch (error) {
    commitMessages = [];
  }
  
  // Get test analysis for action items
  const testAnalysis = await findRelatedTests(changedFiles, repoRoot);
  
  // Get indirect dependencies for risk analysis
  const dependencies = await findIndirectDependencies(changedFiles, repoRoot);
  
  // Analyze risks and potential issues
  const riskAnalysis = analyzeRisksAndImpact(changedFiles, testAnalysis, dependencies, diff);
  
  // Generate developer action items
  const actionItems = generateDeveloperActionItems(changedFiles, testAnalysis);
  
  // Get branch metadata
  let branchAuthor = 'Unknown';
  let branchDate = 'Unknown';
  let ticketNumber = 'Not specified';
  
  try {
    const branchLog = await git.log(['-1', branch]);
    if (branchLog.latest) {
      branchAuthor = `${branchLog.latest.author_name} (${branchLog.latest.author_email})`;
      branchDate = branchLog.latest.date;
    }
    
    // Extract ticket number from commit messages
    const ticketMatch = commitMessages.join(' ').match(/([A-Z]+-\d+)/);
    if (ticketMatch) {
      ticketNumber = ticketMatch[1];
    }
  } catch (error) {
    // Use defaults
  }
  
  // Return structured data
  return {
    branch,
    base,
    branchAuthor,
    branchDate,
    ticketNumber,
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
    commitMessages: commitMessages.join('\n'),
    riskAnalysis,
    developerActionItems: actionItems
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

// Register tools
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
            description: 'Base branch to compare against (default: master)'
          }
        },
        required: ['branch']
      }
    },
    {
      name: 'analyze_indirect_dependencies',
      description: 'Analyze files affected indirectly by branch changes. Finds files that import or depend on changed files, including transitive dependencies.',
      inputSchema: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
            description: 'Branch name to analyze (e.g., "feature/new-feature")'
          },
          base: {
            type: 'string',
            description: 'Base branch to compare against (default: master)'
          }
        },
        required: ['branch']
      }
    },
    {
      name: 'analyze_test_coverage',
      description: 'Analyze test coverage for branch changes. Finds related test files, calculates coverage percentage, and identifies files without tests.',
      inputSchema: {
        type: 'object',
        properties: {
          branch: {
            type: 'string',
            description: 'Branch name to analyze (e.g., "feature/new-feature")'
          },
          base: {
            type: 'string',
            description: 'Base branch to compare against (default: master)'
          }
        },
        required: ['branch']
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { branch, base } = request.params.arguments as { branch: string; base?: string };
  const baseBranch = base || DEFAULT_BASE_BRANCH;
  
  try {
    if (request.params.name === 'analyze_pr') {
      const result = await analyzePR(branch, baseBranch);
      
      // Format risk level with emoji
      const riskEmoji = {
        'Low': '🟢',
        'Medium': '🟡',
        'High': '🟠',
        'Critical': '🔴'
      };
      
      // Build impact statements - "You changed X, it affects Y because Z"
      const impactStatements: string[] = [];
      const changedFilesList = result.changedFiles.split('\n').filter(f => f.trim());
      
      // Categorize files
      const hasSchema = changedFilesList.some(f => f.includes('schema.graphql') || f.includes('schema.gql'));
      const gqlFiles = changedFilesList.filter(f => f.includes('.gql.js') || f.includes('.gql.ts'));
      const moduleFiles = changedFilesList.filter(f => f.includes('module.js') || f.includes('Module.js') || f.includes('module.ts'));
      const componentFiles = changedFilesList.filter(f => f.includes('/components/'));
      const utilFiles = changedFilesList.filter(f => f.includes('/utils/') || f.includes('/shared/') || f.includes('/helpers/'));
      const pageFiles = changedFilesList.filter(f => f.includes('Page.js') || f.includes('Page.tsx'));
      
      // Generate specific impact statements
      if (hasSchema) {
        impactStatements.push(`**GraphQL Schema Changed** → ALL queries/mutations using modified types may break. Check frontend queries.`);
      }
      if (gqlFiles.length > 0) {
        impactStatements.push(`**GraphQL Queries Changed** (${gqlFiles.length} files) → API contract changed. Verify frontend calls.`);
      }
      if (moduleFiles.length > 0) {
        impactStatements.push(`**Backend Modules Changed** (${moduleFiles.length} files) → Business logic affected. Test with real data volumes.`);
      }
      if (utilFiles.length > 0) {
        impactStatements.push(`**Shared Utils Changed** → Used in MULTIPLE places. May break unrelated features.`);
      }
      if (componentFiles.length > 0) {
        impactStatements.push(`**UI Components Changed** (${componentFiles.length} files) → Test across browsers and screen sizes.`);
      }
      if (pageFiles.length > 0) {
        impactStatements.push(`**Page Components Changed** → Test complete user flows on these pages.`);
      }
      
      // Build risks section - only if there are risks
      const allRisks: string[] = [];
      if (result.riskAnalysis.breakingChanges.length > 0) {
        allRisks.push('⚠️ BREAKING CHANGES:');
        result.riskAnalysis.breakingChanges.forEach(r => allRisks.push(`   • ${r}`));
      }
      if (result.riskAnalysis.regressionRisks.length > 0) {
        allRisks.push('🔄 REGRESSION RISKS:');
        result.riskAnalysis.regressionRisks.forEach(r => allRisks.push(`   • ${r}`));
      }
      if (result.riskAnalysis.performanceConcerns.length > 0) {
        allRisks.push('⚡ PERFORMANCE:');
        result.riskAnalysis.performanceConcerns.forEach(r => allRisks.push(`   • ${r}`));
      }
      if (result.riskAnalysis.securityConcerns.length > 0) {
        allRisks.push('🔒 SECURITY:');
        result.riskAnalysis.securityConcerns.forEach(r => allRisks.push(`   • ${r}`));
      }
      if (result.riskAnalysis.missedConsiderations.length > 0) {
        allRisks.push('🤔 MAY HAVE MISSED:');
        result.riskAnalysis.missedConsiderations.forEach(r => allRisks.push(`   • ${r}`));
      }
      
      // Build test steps based on risks
      const testSteps: string[] = [];
      let stepNum = 1;
      
      if (result.riskAnalysis.securityConcerns.length > 0) {
        testSteps.push(`${stepNum}. SECURITY: Test with different user roles, try SQL injection ('; DROP TABLE--), try XSS (<script>alert('x')</script>)`);
        stepNum++;
      }
      if (result.riskAnalysis.performanceConcerns.length > 0) {
        testSteps.push(`${stepNum}. PERFORMANCE: Test with 1000+ records, monitor query time in network tab`);
        stepNum++;
      }
      if (result.riskAnalysis.breakingChanges.length > 0 || result.riskAnalysis.regressionRisks.length > 0) {
        testSteps.push(`${stepNum}. REGRESSION: Test complete user flow, verify existing features still work`);
        stepNum++;
      }
      testSteps.push(`${stepNum}. CORE: Test main feature works, test edge cases (empty, null, special chars)`);
      stepNum++;
      if (componentFiles.length > 0 || pageFiles.length > 0) {
        testSteps.push(`${stepNum}. UI: Test Chrome/Safari/Firefox, test mobile/tablet, test keyboard navigation`);
      }
      
      // Build code pattern warnings section
      const codePatternSection = result.riskAnalysis.codePatternWarnings.length > 0 
        ? `
🔍 CODE PATTERN ANALYSIS (Potential Hidden Bugs)
${result.riskAnalysis.codePatternWarnings.join('\n')}
` : '';
      
      // Concise output - PRESENT THIS AS-IS, DO NOT EXPAND
      const output = `
═══════════════════════════════════════════════════════════════════
BRANCH ANALYSIS: ${branch}
Risk: ${riskEmoji[result.riskAnalysis.riskLevel]} ${result.riskAnalysis.riskLevel.toUpperCase()} | Files: ${result.summary.filesChanged} | Lines: +${result.summary.linesAdded}/-${result.summary.linesDeleted}
═══════════════════════════════════════════════════════════════════

📌 IMPACT OF YOUR CHANGES
${impactStatements.length > 0 ? impactStatements.map(s => `• ${s}`).join('\n') : '• Standard changes with isolated impact'}

${allRisks.length > 0 ? `
🚨 RISKY AREAS TO WATCH
${allRisks.join('\n')}
` : `
✅ NO MAJOR RISKS IDENTIFIED
`}
${codePatternSection}
${result.riskAnalysis.criticalFilesToTest.length > 0 ? `
📁 FILES NEEDING EXTRA ATTENTION
${result.riskAnalysis.criticalFilesToTest.slice(0, 5).map(f => `• ${f}`).join('\n')}
` : ''}
🧪 TEST STEPS
${testSteps.join('\n')}

───────────────────────────────────────────────────────────────────
Changed Files: ${changedFilesList.slice(0, 10).map(f => f.split('\t')[1] || f).join(', ')}${changedFilesList.length > 10 ? ` (+${changedFilesList.length - 10} more)` : ''}
───────────────────────────────────────────────────────────────────
[Present this report as-is. Do not expand or add additional sections.]
`;
      
      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    }
    
    if (request.params.name === 'analyze_indirect_dependencies') {
      const result = await analyzeIndirectDependencies(branch, baseBranch);
      
      const output = `
Indirect Dependency Analysis: ${branch} (base: ${baseBranch})

=== SUMMARY ===
Directly Changed Files: ${result.summary.directlyChanged}
Directly Affected Files: ${result.summary.directlyAffected}
Indirectly Affected Files: ${result.summary.indirectlyAffected}
Total Affected Files: ${result.summary.totalAffected}

=== CHANGED FILES ===
${result.changedFiles.join('\n')}

=== DIRECT DEPENDENCIES ===
${Object.entries(result.directDependencies).map(([changedFile, dependents]) =>
  `\n${changedFile}:\n  → ${dependents.join('\n  → ')}`
).join('\n') || 'None found'}

=== INDIRECT DEPENDENCIES ===
${Object.entries(result.indirectDependencies).map(([file, dependents]) =>
  `\n${file}:\n  → ${dependents.join('\n  → ')}`
).join('\n') || 'None found'}

=== ALL AFFECTED FILES ===
${result.allAffectedFiles.join('\n')}
`;
      
      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    }
    
    if (request.params.name === 'analyze_test_coverage') {
      const result = await analyzeTestCoverage(branch, baseBranch);
      
      const output = `
Test Coverage Analysis: ${branch} (base: ${baseBranch})

=== SUMMARY ===
Files Changed: ${result.summary.filesChanged}
Tests Found: ${result.summary.testsFound}
Coverage: ${result.summary.coveragePercentage}%
Files Without Tests: ${result.summary.filesWithoutTests}

=== TEST COVERAGE ===
Covered: ${result.testCoverage.covered} / ${result.testCoverage.total} files (${result.testCoverage.percentage}%)

=== RELATED TESTS ===
${result.relatedTests.map(test => 
  `\n${test.testFile} (${test.confidence} confidence)
  Related to: ${test.relatedTo.join(', ')}`
).join('\n') || 'No related tests found'}

=== MISSING TESTS ===
Files changed but no related tests found:
${result.missingTests.map(file => `  - ${file}`).join('\n') || '  All files have related tests ✓'}

=== CHANGED FILES ===
${result.changedFiles.join('\n')}
`;
      
      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    }
    
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: ${request.params.name}`
    );
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Error in ${request.params.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Sprinto Impact Analyzer MCP server running on stdio');
}

main().catch(console.error);
