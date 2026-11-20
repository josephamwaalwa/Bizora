import {
  DesktopDatabaseService,
  parseSafeInt64,
  type DatabaseStatus,
  type MigrationDiagnosticDto,
  type MigrationStatusDto,
} from './database';
import {
  classifyWorkspace,
  runExplicitLocalStorageMigration,
  type ExplicitMigrationOutcome,
  type RunMigrationOptions,
  type WorkspaceClassification,
} from './migration';
import {
  createPersistenceAdapter,
  detectPersistenceBackend,
  type PersistenceAdapter,
  type PersistenceBackend,
} from './persistence';
import { StorageService, type RawLegacyStorageSnapshot } from './storage';
import type {
  ActivityLog,
  BusinessProfile,
  Client,
  Invoice,
  Quotation,
} from '../types';
import { isValidThemeMode, THEME_STORAGE_KEY, type ThemeMode } from '../utils/theme';

export interface StartupNotice {
  tone: 'info' | 'warning';
  title: string;
  message: string;
  backupFilename?: string;
  diagnosticsCount: number;
}

export type StartupBlockedReason =
  | 'database_init_failed'
  | 'conflict_existing_data'
  | 'backup_failed'
  | 'validation_failed'
  | 'migration_failed';

export type RuntimeStartupResult =
  | {
      status: 'ready';
      backend: PersistenceBackend;
      adapter: PersistenceAdapter;
      businessProfile: BusinessProfile;
      clients: Client[];
      quotations: Quotation[];
      invoices: Invoice[];
      activities: ActivityLog[];
      themePreference: ThemeMode | null;
      migrationNotice: StartupNotice | null;
    }
  | {
      status: 'blocked';
      backend: 'sqlite';
      reason: StartupBlockedReason;
      title: string;
      message: string;
      backupFilename?: string | null;
      diagnostics: MigrationDiagnosticDto[];
    };

export interface RuntimeStartupDeps {
  detectBackend?: () => PersistenceBackend;
  initBrowserStorage?: () => void;
  createAdapter?: (backend: PersistenceBackend) => PersistenceAdapter;
  initializeDesktopDatabase?: () => Promise<DatabaseStatus | null>;
  getMigrationStatus?: () => Promise<MigrationStatusDto>;
  getRawSnapshot?: () => RawLegacyStorageSnapshot;
  classifySnapshot?: (snapshot: RawLegacyStorageSnapshot) => WorkspaceClassification;
  runMigration?: (options?: RunMigrationOptions) => Promise<ExplicitMigrationOutcome>;
  markMigrationNotNeeded?: (source?: string | null) => Promise<MigrationStatusDto>;
  recordMigrationError?: (diagnostic: MigrationDiagnosticDto) => Promise<MigrationDiagnosticDto>;
}

function buildErrorDiagnostic(params: {
  code: string;
  stage: MigrationDiagnosticDto['stage'];
  entityType: string;
  message: string;
  suggestedAction: string;
}): MigrationDiagnosticDto {
  return {
    code: params.code,
    severity: 'error',
    stage: params.stage,
    entityType: params.entityType,
    recordId: null,
    field: null,
    originalValue: null,
    message: params.message,
    suggestedAction: params.suggestedAction,
  };
}

function extractThemeFromRawSnapshot(snapshot: RawLegacyStorageSnapshot): ThemeMode | null {
  const entry = snapshot.entries.find((item) => item.key === THEME_STORAGE_KEY);
  if (!entry?.present || typeof entry.rawValue !== 'string') {
    return null;
  }

  let candidate: unknown = entry.rawValue.trim();
  if (
    typeof candidate === 'string' &&
    candidate.startsWith('"') &&
    candidate.endsWith('"')
  ) {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      // Leave unparsed for validation below
    }
  }

  return isValidThemeMode(candidate) ? candidate : null;
}

function hasAnySqliteBusinessData(status: MigrationStatusDto): boolean {
  const counts = status.existingCounts;
  return (
    parseSafeInt64(counts.businesses) > 0n ||
    parseSafeInt64(counts.businessAssets) > 0n ||
    parseSafeInt64(counts.clients) > 0n ||
    parseSafeInt64(counts.quotations) > 0n ||
    parseSafeInt64(counts.quotationItems) > 0n ||
    parseSafeInt64(counts.invoices) > 0n ||
    parseSafeInt64(counts.invoiceItems) > 0n ||
    parseSafeInt64(counts.payments) > 0n
  );
}

async function recordDiagnosticSafely(
  recordFn: (diagnostic: MigrationDiagnosticDto) => Promise<MigrationDiagnosticDto>,
  diagnostic: MigrationDiagnosticDto
): Promise<void> {
  try {
    await recordFn(diagnostic);
  } catch {
    // Best-effort diagnostic persistence; never mask the primary startup error.
  }
}

async function hydrateReadyResult(params: {
  backend: PersistenceBackend;
  adapter: PersistenceAdapter;
  migrationNotice?: StartupNotice | null;
  readThemeFromAdapter: boolean;
}): Promise<RuntimeStartupResult> {
  const { backend, adapter, migrationNotice = null, readThemeFromAdapter } = params;
  const [businessProfile, clients, quotations, invoices, activities, rawTheme] = await Promise.all([
    adapter.getBusinessProfile(),
    adapter.getClients(),
    adapter.getQuotations(),
    adapter.getInvoices(),
    adapter.getActivities(),
    readThemeFromAdapter ? adapter.getAppSetting<unknown>('theme_preference') : Promise.resolve(null),
  ]);

  const themePreference = isValidThemeMode(rawTheme) ? rawTheme : null;

  return {
    status: 'ready',
    backend,
    adapter,
    businessProfile,
    clients,
    quotations,
    invoices,
    activities,
    themePreference,
    migrationNotice,
  };
}

/**
 * Coordinates runtime persistence startup across Browser LocalStorage and Desktop SQLite.
 *
 * Guarantees:
 * - Browser mode initializes StorageService cleanly via BrowserPersistenceAdapter.
 * - Desktop SQLite mode NEVER calls `StorageService.init()` and NEVER mutates or deletes
 *   LocalStorage keys before or after migration.
 * - Desktop SQLite migration errors/conflicts block cutover cleanly with diagnostics rather than
 *   silently wiping data or falling back to LocalStorage.
 */
export async function coordinateRuntimeStartup(
  deps?: RuntimeStartupDeps
): Promise<RuntimeStartupResult> {
  const detectBackend = deps?.detectBackend ?? (() => detectPersistenceBackend());
  const initBrowserStorage = deps?.initBrowserStorage ?? (() => StorageService.init());
  const createAdapter =
    deps?.createAdapter ??
    ((targetBackend: PersistenceBackend) =>
      createPersistenceAdapter({
        isDesktopRuntime: () => targetBackend === 'sqlite',
      }));
  const initializeDb =
    deps?.initializeDesktopDatabase ?? (() => DesktopDatabaseService.initializeDesktopDatabase());
  const getMigrationStatus =
    deps?.getMigrationStatus ?? (() => DesktopDatabaseService.getMigrationStatus());
  const getRawSnapshot = deps?.getRawSnapshot ?? (() => StorageService.getRawMigrationSnapshot());
  const classifySnapshot = deps?.classifySnapshot ?? classifyWorkspace;
  const runMigration = deps?.runMigration ?? runExplicitLocalStorageMigration;
  const markNotNeeded =
    deps?.markMigrationNotNeeded ?? ((source?: string | null) => DesktopDatabaseService.markMigrationNotNeeded(source));
  const recordMigrationError =
    deps?.recordMigrationError ?? ((diagnostic: MigrationDiagnosticDto) => DesktopDatabaseService.recordMigrationError(diagnostic));

  const backend = detectBackend();

  if (backend === 'localStorage') {
    initBrowserStorage();
    const adapter = createAdapter('localStorage');
    return hydrateReadyResult({
      backend: 'localStorage',
      adapter,
      readThemeFromAdapter: false,
    });
  }

  // ============================================================
  // Desktop SQLite Startup Gate
  // ============================================================
  try {
    await initializeDb();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unable to open or initialize the local SQLite database.';
    return {
      status: 'blocked',
      backend: 'sqlite',
      reason: 'database_init_failed',
      title: 'SQLite Database Initialization Failed',
      message,
      diagnostics: [
        buildErrorDiagnostic({
          code: 'DATABASE_INIT_FAILED',
          stage: 'verify',
          entityType: 'database',
          message,
          suggestedAction:
            'Verify app data folder permissions and free disk space, then retry startup.',
        }),
      ],
    };
  }

  const adapter = createAdapter('sqlite');

  let migrationStatus: MigrationStatusDto;
  try {
    migrationStatus = await getMigrationStatus();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to inspect SQLite migration status.';
    return {
      status: 'blocked',
      backend: 'sqlite',
      reason: 'migration_failed',
      title: 'Migration Status Check Failed',
      message,
      diagnostics: [
        buildErrorDiagnostic({
          code: 'MIGRATION_STATUS_ERROR',
          stage: 'verify',
          entityType: 'migration',
          message,
          suggestedAction: 'Retry database initialization or inspect SQLite application logs.',
        }),
      ],
    };
  }

  if (migrationStatus.state === 'conflict_existing_data') {
    return {
      status: 'blocked',
      backend: 'sqlite',
      reason: 'conflict_existing_data',
      title: 'Existing SQLite Data Conflict Detected',
      message:
        'SQLite already contains unmigrated workspace records alongside legacy LocalStorage data. Cutover is paused so no data is overwritten.',
      backupFilename: migrationStatus.backupFilename,
      diagnostics: migrationStatus.lastError ? [migrationStatus.lastError] : [],
    };
  }

  if (migrationStatus.state === 'completed') {
    if (parseSafeInt64(migrationStatus.existingCounts.businesses) === 0n) {
      await adapter.clearAllData();
    }
    return hydrateReadyResult({
      backend: 'sqlite',
      adapter,
      readThemeFromAdapter: true,
    });
  }

  if (migrationStatus.state === 'not_needed') {
    if (parseSafeInt64(migrationStatus.existingCounts.businesses) === 0n) {
      await adapter.resetToDemoData();
    }
    return hydrateReadyResult({
      backend: 'sqlite',
      adapter,
      readThemeFromAdapter: true,
    });
  }

  // migrationStatus.state === 'absent'
  if (hasAnySqliteBusinessData(migrationStatus)) {
    const conflictDiagnostic = buildErrorDiagnostic({
      code: 'CONFLICT_EXISTING_SQLITE_DATA',
      stage: 'verify',
      entityType: 'workspace',
      message:
        'SQLite already contains workspace records without a completed migration marker. Automatic overwrite was blocked to protect your data.',
      suggestedAction:
        'Back up your SQLite database and legacy LocalStorage data before resolving the conflict.',
    });
    await recordDiagnosticSafely(recordMigrationError, conflictDiagnostic);
    return {
      status: 'blocked',
      backend: 'sqlite',
      reason: 'conflict_existing_data',
      title: 'Existing SQLite Workspace Requires Conflict Resolution',
      message: conflictDiagnostic.message,
      backupFilename: migrationStatus.backupFilename,
      diagnostics: [conflictDiagnostic],
    };
  }

  // First-launch SQLite migration evaluation (LocalStorage read-only snapshot; NEVER StorageService.init())
  const snapshot = getRawSnapshot();
  const classification = classifySnapshot(snapshot);
  const snapshotTheme = extractThemeFromRawSnapshot(snapshot);

  if (classification === 'empty_fresh_install') {
    await markNotNeeded('desktop_fresh_install');
    await adapter.resetToDemoData();
    if (snapshotTheme) {
      await adapter.saveAppSetting('theme_preference', snapshotTheme);
    }
    return hydrateReadyResult({
      backend: 'sqlite',
      adapter,
      readThemeFromAdapter: true,
    });
  }

  let outcome: ExplicitMigrationOutcome;
  try {
    outcome = await runMigration({ migrateDemoSeed: false });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unexpected failure while migrating LocalStorage workspace to SQLite.';
    const diag = buildErrorDiagnostic({
      code: 'MIGRATION_EXECUTION_FAILED',
      stage: 'sqlite_import',
      entityType: 'workspace',
      message,
      suggestedAction:
        'Your original LocalStorage data has been left untouched. Inspect diagnostics and retry migration.',
    });
    await recordDiagnosticSafely(recordMigrationError, diag);
    return {
      status: 'blocked',
      backend: 'sqlite',
      reason: 'migration_failed',
      title: 'Desktop Workspace Migration Failed',
      message,
      diagnostics: [diag],
    };
  }

  switch (outcome.outcome) {
    case 'already_completed':
      return hydrateReadyResult({
        backend: 'sqlite',
        adapter,
        readThemeFromAdapter: true,
      });

    case 'empty_fresh_install':
      await markNotNeeded('desktop_fresh_install');
      await adapter.resetToDemoData();
      if (snapshotTheme) {
        await adapter.saveAppSetting('theme_preference', snapshotTheme);
      }
      return hydrateReadyResult({
        backend: 'sqlite',
        adapter,
        readThemeFromAdapter: true,
      });

    case 'demo_seed_only':
      await markNotNeeded('demo_seed_only');
      await adapter.resetToDemoData();
      if (snapshotTheme) {
        await adapter.saveAppSetting('theme_preference', snapshotTheme);
      }
      return hydrateReadyResult({
        backend: 'sqlite',
        adapter,
        readThemeFromAdapter: true,
      });

    case 'completed': {
      const warningCount = outcome.diagnostics.filter((d) => d.severity === 'warning').length;
      const migrationNotice: StartupNotice = {
        tone: warningCount > 0 ? 'warning' : 'info',
        title: 'Workspace Migrated to Local SQLite Database',
        message:
          warningCount > 0
            ? `Migrated ${outcome.result.counts.clients} clients, ${outcome.result.counts.quotations} quotations, and ${outcome.result.counts.invoices} invoices with ${warningCount} normalization notice(s). Backup saved as ${outcome.backup.backupFilename}.`
            : `Safely migrated ${outcome.result.counts.clients} clients, ${outcome.result.counts.quotations} quotations, and ${outcome.result.counts.invoices} invoices. Raw backup saved as ${outcome.backup.backupFilename}.`,
        backupFilename: outcome.backup.backupFilename,
        diagnosticsCount: warningCount,
      };
      return hydrateReadyResult({
        backend: 'sqlite',
        adapter,
        migrationNotice,
        readThemeFromAdapter: true,
      });
    }

    case 'conflict_existing_data': {
      const diag =
        outcome.diagnostics[0] ??
        buildErrorDiagnostic({
          code: 'CONFLICT_EXISTING_SQLITE_DATA',
          stage: 'verify',
          entityType: 'workspace',
          message:
            'SQLite contains existing records alongside legacy LocalStorage data.',
          suggestedAction: 'Review existing SQLite data and backup files before retrying.',
        });
      return {
        status: 'blocked',
        backend: 'sqlite',
        reason: 'conflict_existing_data',
        title: 'Existing SQLite Workspace Conflict',
        message: diag.message,
        backupFilename: outcome.status.backupFilename,
        diagnostics: outcome.diagnostics.length > 0 ? outcome.diagnostics : [diag],
      };
    }

    case 'backup_failed': {
      const diag =
        outcome.diagnostics[0] ??
        buildErrorDiagnostic({
          code: 'BACKUP_FAILED',
          stage: 'backup',
          entityType: 'backup',
          message: 'Pre-migration LocalStorage backup failed before import began.',
          suggestedAction: 'Ensure disk space and write permissions are available, then retry.',
        });
      await recordDiagnosticSafely(recordMigrationError, diag);
      return {
        status: 'blocked',
        backend: 'sqlite',
        reason: 'backup_failed',
        title: 'Pre-Migration Safety Backup Failed',
        message: diag.message,
        diagnostics: outcome.diagnostics.length > 0 ? outcome.diagnostics : [diag],
      };
    }

    case 'validation_failed': {
      const firstError =
        outcome.diagnostics.find((d) => d.severity === 'error') ??
        outcome.diagnostics[0] ??
        buildErrorDiagnostic({
          code: 'MIGRATION_VALIDATION_FAILED',
          stage: 'validate',
          entityType: 'workspace',
          message: 'Legacy LocalStorage data failed validation before SQLite import.',
          suggestedAction:
            'Review the reported diagnostics. Your LocalStorage data was preserved and backed up on disk.',
        });
      await recordDiagnosticSafely(recordMigrationError, firstError);
      return {
        status: 'blocked',
        backend: 'sqlite',
        reason: 'validation_failed',
        title: 'LocalStorage Migration Validation Issues Found',
        message: firstError.message,
        backupFilename: outcome.backup.backupFilename,
        diagnostics: outcome.diagnostics.length > 0 ? outcome.diagnostics : [firstError],
      };
    }
  }
}
