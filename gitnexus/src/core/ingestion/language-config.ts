import fs from 'fs/promises';
import path from 'path';

const isDev = process.env.NODE_ENV === 'development';

// ============================================================================
// LANGUAGE-SPECIFIC CONFIG TYPES
// ============================================================================

/** TypeScript path alias config parsed from tsconfig.json */
export interface TsconfigPaths {
  /** Map of alias prefix -> target prefix (e.g., "@/" -> "src/") */
  aliases: Map<string, string>;
  /** Base URL for path resolution (relative to repo root) */
  baseUrl: string;
}

/** Go module config parsed from go.mod */
export interface GoModuleConfig {
  /** Module path (e.g., "github.com/user/repo") */
  modulePath: string;
}

/** PHP Composer PSR-4 autoload config */
export interface ComposerConfig {
  /** Map of namespace prefix -> directory (e.g., "App\\" -> "app/") */
  psr4: Map<string, string>;
}

/** C# project config parsed from .csproj files */
export interface CSharpProjectConfig {
  /** Root namespace from <RootNamespace> or assembly name (default: project directory name) */
  rootNamespace: string;
  /** Directory containing the .csproj file */
  projectDir: string;
}

/** Python source roots config — maps top-level import names to filesystem directories */
export interface PythonSourceRootsConfig {
  /**
   * Ordered list of source root directories (relative to repo root).
   * Each root is a directory where Python packages live as direct children.
   * e.g., ["projects", "libraries/python"] means `from pkg_core.clients.base import X`
   * resolves to `projects/pkg_core/clients/base.py`.
   */
  sourceRoots: string[];
}

/** Swift Package Manager module config */
export interface SwiftPackageConfig {
  /** Map of target name -> source directory path (e.g., "SiuperModel" -> "Package/Sources/SiuperModel") */
  targets: Map<string, string>;
}

// ============================================================================
// LANGUAGE-SPECIFIC CONFIG LOADERS
// ============================================================================

/**
 * Parse tsconfig.json to extract path aliases.
 * Tries tsconfig.json, tsconfig.app.json, tsconfig.base.json in order.
 */
export async function loadTsconfigPaths(repoRoot: string): Promise<TsconfigPaths | null> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

  for (const filename of candidates) {
    try {
      const tsconfigPath = path.join(repoRoot, filename);
      const raw = await fs.readFile(tsconfigPath, 'utf-8');
      // Strip JSON comments (// and /* */ style) for robustness
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped);
      const compilerOptions = tsconfig.compilerOptions;
      if (!compilerOptions?.paths) continue;

      const baseUrl = compilerOptions.baseUrl || '.';
      const aliases = new Map<string, string>();

      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const target = targets[0] as string;

        // Convert glob patterns: "@/*" -> "@/", "src/*" -> "src/"
        const aliasPrefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
        const targetPrefix = target.endsWith('/*') ? target.slice(0, -1) : target;

        aliases.set(aliasPrefix, targetPrefix);
      }

      if (aliases.size > 0) {
        if (isDev) {
          console.log(`📦 Loaded ${aliases.size} path aliases from ${filename}`);
        }
        return { aliases, baseUrl };
      }
    } catch {
      // File doesn't exist or isn't valid JSON - try next
    }
  }

  return null;
}

/**
 * Parse go.mod to extract module path.
 */
export async function loadGoModulePath(repoRoot: string): Promise<GoModuleConfig | null> {
  try {
    const goModPath = path.join(repoRoot, 'go.mod');
    const content = await fs.readFile(goModPath, 'utf-8');
    const match = content.match(/^module\s+(\S+)/m);
    if (match) {
      if (isDev) {
        console.log(`📦 Loaded Go module path: ${match[1]}`);
      }
      return { modulePath: match[1] };
    }
  } catch {
    // No go.mod
  }
  return null;
}

/** Parse composer.json to extract PSR-4 autoload mappings (including autoload-dev). */
export async function loadComposerConfig(repoRoot: string): Promise<ComposerConfig | null> {
  try {
    const composerPath = path.join(repoRoot, 'composer.json');
    const raw = await fs.readFile(composerPath, 'utf-8');
    const composer = JSON.parse(raw);
    const psr4Raw = composer.autoload?.['psr-4'] ?? {};
    const psr4Dev = composer['autoload-dev']?.['psr-4'] ?? {};
    const merged = { ...psr4Raw, ...psr4Dev };

    const psr4 = new Map<string, string>();
    for (const [ns, dir] of Object.entries(merged)) {
      const nsNorm = (ns as string).replace(/\\+$/, '');
      const dirNorm = (dir as string).replace(/\\/g, '/').replace(/\/+$/, '');
      psr4.set(nsNorm, dirNorm);
    }

    if (isDev) {
      console.log(`📦 Loaded ${psr4.size} PSR-4 mappings from composer.json`);
    }
    return { psr4 };
  } catch {
    return null;
  }
}

/**
 * Parse .csproj files to extract RootNamespace.
 * Scans the repo root for .csproj files and returns configs for each.
 */
export async function loadCSharpProjectConfig(repoRoot: string): Promise<CSharpProjectConfig[]> {
  const configs: CSharpProjectConfig[] = [];
  // BFS scan for .csproj files up to 5 levels deep, cap at 100 dirs to avoid runaway scanning
  const scanQueue: { dir: string; depth: number }[] = [{ dir: repoRoot, depth: 0 }];
  const maxDepth = 5;
  const maxDirs = 100;
  let dirsScanned = 0;

  while (scanQueue.length > 0 && dirsScanned < maxDirs) {
    const { dir, depth } = scanQueue.shift()!;
    dirsScanned++;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && depth < maxDepth) {
          // Skip common non-project directories
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'bin' || entry.name === 'obj') continue;
          scanQueue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
        if (entry.isFile() && entry.name.endsWith('.csproj')) {
          try {
            const csprojPath = path.join(dir, entry.name);
            const content = await fs.readFile(csprojPath, 'utf-8');
            const nsMatch = content.match(/<RootNamespace>\s*([^<]+)\s*<\/RootNamespace>/);
            const rootNamespace = nsMatch
              ? nsMatch[1].trim()
              : entry.name.replace(/\.csproj$/, '');
            const projectDir = path.relative(repoRoot, dir).replace(/\\/g, '/');
            configs.push({ rootNamespace, projectDir });
            if (isDev) {
              console.log(`📦 Loaded C# project: ${entry.name} (namespace: ${rootNamespace}, dir: ${projectDir})`);
            }
          } catch {
            // Can't read .csproj
          }
        }
      }
    } catch {
      // Can't read directory
    }
  }
  return configs;
}

export async function loadSwiftPackageConfig(repoRoot: string): Promise<SwiftPackageConfig | null> {
  // Swift imports are module-name based (e.g., `import SiuperModel`)
  // SPM convention: Sources/<TargetName>/ or Package/Sources/<TargetName>/
  // We scan for these directories to build a target map
  const targets = new Map<string, string>();

  const sourceDirs = ['Sources', 'Package/Sources', 'src'];
  for (const sourceDir of sourceDirs) {
    try {
      const fullPath = path.join(repoRoot, sourceDir);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          targets.set(entry.name, sourceDir + '/' + entry.name);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  if (targets.size > 0) {
    if (isDev) {
      console.log(`📦 Loaded ${targets.size} Swift package targets`);
    }
    return { targets };
  }
  return null;
}

/**
 * Discover Python source roots for a repository.
 *
 * Discovery order (first match wins):
 * 1. `.gitnexus/python.json` — manual override: `{ "sourceRoots": ["src", "lib"] }`
 * 2. `pants.toml` — Pants monorepo: scan for directories containing BUILD files
 *    with `python_sources` or `python_library` targets, then infer roots.
 *    Uses `[source].root_patterns` if defined, otherwise uses Pants' default
 *    marker files (pyproject.toml, setup.py, setup.cfg) to detect roots.
 * 3. `pyproject.toml` — single-project: check tool.setuptools.packages.find.where,
 *    tool.poetry.packages, or default "src" layout.
 *
 * Falls back to scanning for common root directories (src/, lib/, projects/, libraries/).
 */
export async function loadPythonSourceRoots(repoRoot: string): Promise<PythonSourceRootsConfig | null> {
  // 1. Manual override via .gitnexus/python.json
  try {
    const configPath = path.join(repoRoot, '.gitnexus', 'python.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (Array.isArray(config.sourceRoots) && config.sourceRoots.length > 0) {
      const sourceRoots = config.sourceRoots.map((r: string) => r.replace(/\/+$/, ''));
      if (isDev) {
        console.log(`🐍 Loaded ${sourceRoots.length} Python source roots from .gitnexus/python.json`);
      }
      return { sourceRoots };
    }
  } catch {
    // No manual config
  }

  // 2. Pants monorepo detection via pants.toml
  try {
    const pantsTomlPath = path.join(repoRoot, 'pants.toml');
    await fs.access(pantsTomlPath);

    // Pants uses marker files to detect source roots. The default markers are
    // pyproject.toml, setup.py, setup.cfg, and BUILD files at root level.
    // We scan for directories that contain __init__.py as direct children
    // (i.e., are Python package roots) and look for common Pants source root patterns.
    const sourceRoots = await discoverPantsSourceRoots(repoRoot);
    if (sourceRoots.length > 0) {
      if (isDev) {
        console.log(`🐍 Discovered ${sourceRoots.length} Pants source roots: ${sourceRoots.join(', ')}`);
      }
      return { sourceRoots };
    }
  } catch {
    // No pants.toml
  }

  // 3. pyproject.toml — setuptools or poetry
  try {
    const pyprojectPath = path.join(repoRoot, 'pyproject.toml');
    const raw = await fs.readFile(pyprojectPath, 'utf-8');

    // Quick TOML parsing for common patterns (no full TOML parser dependency)
    // Look for: [tool.setuptools.packages.find] where = ["src"]
    const whereMatch = raw.match(/\[tool\.setuptools\.packages\.find\][^[]*where\s*=\s*\["([^"]+)"\]/s);
    if (whereMatch) {
      if (isDev) {
        console.log(`🐍 Loaded Python source root from pyproject.toml: ${whereMatch[1]}`);
      }
      return { sourceRoots: [whereMatch[1]] };
    }

    // Look for src/ layout (PEP 517 convention)
    try {
      await fs.access(path.join(repoRoot, 'src'));
      if (isDev) {
        console.log(`🐍 Detected src/ layout from pyproject.toml presence`);
      }
      return { sourceRoots: ['src'] };
    } catch {
      // No src/ directory
    }
  } catch {
    // No pyproject.toml
  }

  return null;
}

/**
 * Discover source roots in a Pants monorepo by scanning for directories
 * that are parents of Python packages (directories with __init__.py).
 *
 * Strategy: Look for well-known Pants source root patterns. Pants' default
 * `root_patterns` include directories like `src/python`, `src/py`, `src`,
 * and any directory containing a `setup.py`, `setup.cfg`, or `pyproject.toml`.
 * In practice, monorepos use patterns like `projects/`, `libraries/python/`, etc.
 *
 * We scan up to 3 levels deep for directories that:
 * - Contain at least one subdirectory with `__init__.py` (are package roots)
 * - OR contain a BUILD file (Pants target definition)
 */
async function discoverPantsSourceRoots(repoRoot: string): Promise<string[]> {
  const roots = new Set<string>();
  const maxDepth = 3;
  const maxDirs = 200;
  let dirsScanned = 0;

  const scanQueue: { dir: string; depth: number; rel: string }[] = [
    { dir: repoRoot, depth: 0, rel: '' },
  ];

  // Skip directories that are never source roots
  const skipDirs = new Set([
    'node_modules', '.git', '.pants.d', 'pants.d', '__pycache__',
    '.mypy_cache', '.pytest_cache', 'dist', 'build', '.tox', '.venv',
    'venv', '.gitnexus',
  ]);

  while (scanQueue.length > 0 && dirsScanned < maxDirs) {
    const { dir, depth, rel } = scanQueue.shift()!;
    dirsScanned++;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const subdirs: { name: string; path: string }[] = [];
      let hasInitPy = false;

      for (const entry of entries) {
        if (entry.isFile() && entry.name === '__init__.py') {
          hasInitPy = true;
        }
        if (entry.isDirectory() && !skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
          subdirs.push({ name: entry.name, path: path.join(dir, entry.name) });
        }
      }

      // If this directory has __init__.py, its parent is a source root
      if (hasInitPy && rel) {
        // The parent directory (one level up) is the source root
        const parentRel = rel.split('/').slice(0, -1).join('/');
        if (parentRel) {
          roots.add(parentRel);
        }
      }

      // Continue scanning subdirectories
      if (depth < maxDepth) {
        for (const subdir of subdirs) {
          const subRel = rel ? `${rel}/${subdir.name}` : subdir.name;
          scanQueue.push({ dir: subdir.path, depth: depth + 1, rel: subRel });
        }
      }
    } catch {
      // Can't read directory
    }
  }

  // Sort by specificity (longer paths first) so more specific roots match before generic ones
  return [...roots].sort((a, b) => b.length - a.length);
}
