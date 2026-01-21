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

// Get diff between branches
async function getDiff(base: string, head: string): Promise<string> {
  try {
    const diff = await git.diff([`${base}...${head}`]);
    // Limit to MAX_DIFF_SIZE to avoid token limits
    return diff.slice(0, MAX_DIFF_SIZE);
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

// Analyze risks and potential issues in the changes
function analyzeRisksAndImpact(changedFiles: Array<{ path: string; status: string; additions: number; deletions: number }>, testAnalysis: { relatedTests: any[]; missingTests: string[]; testCoverage: any }): {
  riskLevel: 'Low' | 'Medium' | 'High' | 'Critical';
  breakingChanges: string[];
  regressionRisks: string[];
  performanceConcerns: string[];
  securityConcerns: string[];
  dataIntegrityRisks: string[];
  areasAffected: string[];
  criticalFilesToTest: string[];
  missedConsiderations: string[];
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
    missedConsiderations: [] as string[]
  };
  
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
  
  // Breaking changes potential
  if (hasSchemaChanges) {
    risks.breakingChanges.push('GraphQL schema modified - verify all queries/mutations still work');
    risks.breakingChanges.push('Check if frontend queries need updates');
    risks.criticalFilesToTest.push(...changedFiles.filter(f => f.path.includes('schema')).map(f => f.path));
  }
  
  if (hasAPIChanges) {
    risks.breakingChanges.push('API changes detected - verify backward compatibility');
    risks.breakingChanges.push('Check if any consumers depend on modified API contracts');
    risks.criticalFilesToTest.push(...changedFiles.filter(f => f.path.includes('.gql.js') || f.path.includes('/api/')).map(f => f.path));
  }
  
  if (hasFilesDeletion) {
    risks.breakingChanges.push('Significant code deletion detected - verify no dependent code breaks');
    risks.regressionRisks.push('Removed functionality may be referenced elsewhere');
  }
  
  // Regression risks
  if (hasUtilityChanges) {
    risks.regressionRisks.push('Utility/helper functions modified - test ALL usages across codebase');
    risks.regressionRisks.push('Shared utilities may have multiple consumers that need retesting');
    risks.criticalFilesToTest.push(...changedFiles.filter(f => f.path.includes('/utils/') || f.path.includes('/helpers/')).map(f => f.path));
  }
  
  if (hasStateManagement) {
    risks.regressionRisks.push('State management changed - verify all components consuming this state');
    risks.regressionRisks.push('Check for side effects in related components');
  }
  
  if (hasUIComponents && hasMultipleFiles) {
    risks.regressionRisks.push('Multiple UI components changed - test inter-component interactions');
    risks.regressionRisks.push('Verify parent-child component relationships still work');
  }
  
  if (testAnalysis.missingTests.length > 0) {
    risks.regressionRisks.push(`${testAnalysis.missingTests.length} files changed without test coverage - HIGH regression risk`);
  }
  
  // Performance concerns
  if (hasDBChanges) {
    risks.performanceConcerns.push('Database query changes - verify query performance with production-like data');
    risks.performanceConcerns.push('Check if new queries need indexes');
    risks.performanceConcerns.push('Test with large datasets (1000+ records)');
    risks.dataIntegrityRisks.push('Database changes require careful testing of data constraints');
  }
  
  const hasJSONBSearch = changedFiles.some(f => {
    return f.path.includes('module.js') || f.path.includes('gql.js');
  });
  
  if (hasJSONBSearch) {
    risks.performanceConcerns.push('JSONB queries detected - may be slow on large datasets without proper indexing');
    risks.performanceConcerns.push('Consider adding GIN index for JSONB search performance');
    risks.missedConsiderations.push('JSONB search performance not optimized - add database indexes');
  }
  
  if (isLargeChange) {
    risks.performanceConcerns.push('Large change detected - profile memory usage and performance impact');
  }
  
  // Security concerns
  if (hasAuthChanges) {
    risks.securityConcerns.push('Authentication/authorization logic changed - CRITICAL security review needed');
    risks.securityConcerns.push('Verify users cannot access unauthorized resources');
    risks.securityConcerns.push('Test with different user roles and permission levels');
    risks.criticalFilesToTest.push(...changedFiles.filter(f => f.path.toLowerCase().includes('auth') || f.path.toLowerCase().includes('permission')).map(f => f.path));
  }
  
  if (hasAPIChanges || hasDBChanges) {
    risks.securityConcerns.push('Test for SQL injection vulnerabilities');
    risks.securityConcerns.push('Verify input validation and sanitization');
    risks.securityConcerns.push('Check for proper error handling (no sensitive data exposure)');
  }
  
  const hasUserInput = changedFiles.some(f => 
    f.path.includes('form') || 
    f.path.includes('input') ||
    f.path.includes('search')
  );
  
  if (hasUserInput) {
    risks.securityConcerns.push('User input handling modified - test XSS and injection attacks');
    risks.securityConcerns.push('Verify special characters are properly escaped');
  }
  
  // Data integrity risks
  if (hasDBChanges) {
    risks.dataIntegrityRisks.push('Verify data migrations work correctly (up AND down)');
    risks.dataIntegrityRisks.push('Test rollback scenarios');
    risks.dataIntegrityRisks.push('Ensure no data loss during migration');
  }
  
  const hasDataTransformation = changedFiles.some(f =>
    f.path.includes('transform') ||
    f.path.includes('mapper') ||
    f.path.includes('converter')
  );
  
  if (hasDataTransformation) {
    risks.dataIntegrityRisks.push('Data transformation logic changed - verify data integrity end-to-end');
    risks.dataIntegrityRisks.push('Test with edge cases (null, empty, special characters)');
  }
  
  // Missed considerations
  if (hasConfigChanges) {
    risks.missedConsiderations.push('Update environment variable documentation and .env.example');
    risks.missedConsiderations.push('Notify team of any new configuration requirements');
  }
  
  if (hasSchemaChanges && !changedFiles.some(f => f.path.includes('test'))) {
    risks.missedConsiderations.push('GraphQL schema changed but no test updates detected');
  }
  
  const hasDebounce = changedFiles.some(f => f.path.includes('Page.js') || f.path.includes('component'));
  if (hasDebounce) {
    risks.missedConsiderations.push('If using debounce/timers - verify cleanup on component unmount (memory leaks)');
    risks.missedConsiderations.push('Test rapid user interactions (race conditions)');
  }
  
  if (hasUIComponents) {
    risks.missedConsiderations.push('Test browser compatibility (Chrome, Firefox, Safari)');
    risks.missedConsiderations.push('Test responsive design on mobile/tablet');
    risks.missedConsiderations.push('Verify accessibility (keyboard navigation, screen readers)');
  }
  
  if (testAnalysis.testCoverage.percentage < 70) {
    risks.missedConsiderations.push(`Test coverage is ${testAnalysis.testCoverage.percentage}% - add tests before merging`);
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
  
  // Analyze risks and potential issues
  const riskAnalysis = analyzeRisksAndImpact(changedFiles, testAnalysis);
  
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
      
      // Build impact statements
      const impactStatements: string[] = [];
      
      // Generate "You changed X, it affects Y because Z" statements
      const changedFilesList = result.changedFiles.split('\n').filter(f => f.trim());
      const filesByType: Record<string, string[]> = {};
      
      changedFilesList.forEach(file => {
        const filePath = file.split('\t')[1];
        if (!filePath) return;
        
        if (filePath.includes('schema.graphql')) {
          if (!filesByType['GraphQL Schema']) filesByType['GraphQL Schema'] = [];
          filesByType['GraphQL Schema'].push(filePath);
        } else if (filePath.includes('.gql.js')) {
          if (!filesByType['GraphQL Queries']) filesByType['GraphQL Queries'] = [];
          filesByType['GraphQL Queries'].push(filePath);
        } else if (filePath.includes('module.js') || filePath.includes('Module.js')) {
          if (!filesByType['Backend Modules']) filesByType['Backend Modules'] = [];
          filesByType['Backend Modules'].push(filePath);
        } else if (filePath.includes('/components/')) {
          if (!filesByType['Frontend Components']) filesByType['Frontend Components'] = [];
          filesByType['Frontend Components'].push(filePath);
        } else if (filePath.includes('/utils/') || filePath.includes('/shared/')) {
          if (!filesByType['Shared Utilities']) filesByType['Shared Utilities'] = [];
          filesByType['Shared Utilities'].push(filePath);
        }
      });
      
      // Generate impact statements based on file types
      if (filesByType['GraphQL Schema']) {
        impactStatements.push(`• You modified **GraphQL Schema** → This affects ALL queries/mutations using these types. Frontend queries may break if they request removed/renamed fields.`);
      }
      
      if (filesByType['GraphQL Queries']) {
        impactStatements.push(`• You modified **GraphQL Queries** (${filesByType['GraphQL Queries'].length} file${filesByType['GraphQL Queries'].length > 1 ? 's' : ''}) → This changes the API contract. Any frontend code calling these queries needs verification.`);
      }
      
      if (filesByType['Backend Modules']) {
        impactStatements.push(`• You modified **Backend Modules** (${filesByType['Backend Modules'].length} file${filesByType['Backend Modules'].length > 1 ? 's' : ''}) → This affects business logic and database operations. Test with production-like data volumes.`);
      }
      
      if (filesByType['Frontend Components']) {
        impactStatements.push(`• You modified **${filesByType['Frontend Components'].length} Frontend Component${filesByType['Frontend Components'].length > 1 ? 's' : ''}** → This affects user interface. Test across browsers, screen sizes, and user permissions.`);
      }
      
      if (filesByType['Shared Utilities']) {
        impactStatements.push(`• You modified **Shared Utilities** → These are used in MULTIPLE places. Changes here can cause unexpected breaks in seemingly unrelated features.`);
      }
      
      // Format as ultra-concise, impact-focused report
      const output = `
# Branch Analysis: ${branch}

**Risk Level**: ${riskEmoji[result.riskAnalysis.riskLevel]} **${result.riskAnalysis.riskLevel}** | **Files Changed**: ${result.summary.filesChanged} | **Ticket**: ${result.ticketNumber}

---

## 1. What You Changed & Its Impact

${impactStatements.length > 0 ? impactStatements.join('\n\n') : '• Standard code changes with isolated impact'}

${result.riskAnalysis.areasAffected.length > 0 ? `\n**Systems Affected**: ${result.riskAnalysis.areasAffected.join(', ')}` : ''}

---

## 2. Risky Areas You Should Know About

${result.riskAnalysis.breakingChanges.length > 0 ? `### ⚠️ Breaking Changes\n${result.riskAnalysis.breakingChanges.map(r => `• ${r}`).join('\n')}\n` : ''}${result.riskAnalysis.regressionRisks.length > 0 ? `### 🔄 Regression Risks\n${result.riskAnalysis.regressionRisks.map(r => `• ${r}`).join('\n')}\n` : ''}${result.riskAnalysis.performanceConcerns.length > 0 ? `### ⚡ Performance Issues\n${result.riskAnalysis.performanceConcerns.map(r => `• ${r}`).join('\n')}\n` : ''}${result.riskAnalysis.securityConcerns.length > 0 ? `### 🔒 Security Risks\n${result.riskAnalysis.securityConcerns.map(r => `• ${r}`).join('\n')}\n` : ''}${result.riskAnalysis.dataIntegrityRisks.length > 0 ? `### 💾 Data Integrity\n${result.riskAnalysis.dataIntegrityRisks.map(r => `• ${r}`).join('\n')}\n` : ''}${result.riskAnalysis.missedConsiderations.length > 0 ? `### 🤔 Things You Might Have Missed\n${result.riskAnalysis.missedConsiderations.map(r => `• ${r}`).join('\n')}` : ''}
${result.riskAnalysis.breakingChanges.length === 0 && result.riskAnalysis.regressionRisks.length === 0 && result.riskAnalysis.performanceConcerns.length === 0 && result.riskAnalysis.securityConcerns.length === 0 && result.riskAnalysis.dataIntegrityRisks.length === 0 && result.riskAnalysis.missedConsiderations.length === 0 ? '✅ **No major risks identified** - This looks like a safe change' : ''}

${result.riskAnalysis.criticalFilesToTest.length > 0 ? `\n**Critical Files Needing Extra Attention**:\n${result.riskAnalysis.criticalFilesToTest.slice(0, 5).map(f => `• \`${f}\``).join('\n')}${result.riskAnalysis.criticalFilesToTest.length > 5 ? `\n• ... and ${result.riskAnalysis.criticalFilesToTest.length - 5} more` : ''}` : ''}

---

## 3. Test Steps to Verify Your Changes

${result.riskAnalysis.securityConcerns.length > 0 ? `### 🔒 Security Testing (CRITICAL)
1. Test with different user roles (admin, regular user, restricted user)
2. Try SQL injection: Enter \`'; DROP TABLE--\` in search/input fields
3. Try XSS: Enter \`<script>alert('test')</script>\` in text fields
4. Verify unauthorized users cannot access new features
` : ''}${result.riskAnalysis.performanceConcerns.length > 0 ? `### ⚡ Performance Testing
1. Test with large datasets (1000+ records)
2. Monitor network tab - check query execution time
3. Verify pagination works correctly with search/filters
` : ''}${result.riskAnalysis.breakingChanges.length > 0 || result.riskAnalysis.regressionRisks.length > 0 ? `### 🔄 Regression Testing
1. Test the complete user flow from start to finish
2. Verify existing features that use modified files still work
3. Test edge cases: empty states, no data, invalid inputs
` : ''}### ✅ Core Functionality
1. Test the main feature you built works as expected
2. Test with realistic data (not just test data)
3. Verify error messages are user-friendly
4. Test on different browsers (Chrome, Safari, Firefox)
${filesByType['Frontend Components'] ? '5. Test on mobile and tablet screen sizes\n6. Test keyboard navigation and accessibility' : ''}

${result.riskAnalysis.dataIntegrityRisks.length > 0 ? `### 💾 Database/Data Testing
1. Verify data migrations work (if applicable)
2. Test rollback scenario
3. Check data integrity with edge cases (null, empty, special chars)
` : ''}
---

## Changed Files
\`\`\`
${changedFilesList.slice(0, 15).join('\n')}${changedFilesList.length > 15 ? `\n... and ${changedFilesList.length - 15} more files` : ''}
\`\`\`
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
