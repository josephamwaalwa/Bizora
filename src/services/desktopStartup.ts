import type {
  ActivityLog,
  BusinessProfile,
  Client,
  Invoice,
  Quotation,
} from '../types';
import { isValidThemeMode, THEME_STORAGE_KEY, type ThemeMode } from '../utils/theme';
import {
  DesktopDatabaseService,
  isDatabaseCommandError,
  type BackupLegacyStorageResult,
  type DatabaseStatus,
  type MigrationCountsDto,
  type MigrationDiagnosticDto,
  type MigrationStatusDto,
} from './database';
import {
  classifyWorkspace,
  runExplicitLocalStorageMigration,
  type ExplicitMigrationOutcome,
  type MigrationRunnerDeps,
  type RunMigrationOptions,
} from './migration';
import type { PersistenceAdapter } from './persistence/types';
import { StorageService, type RawLegacyStorageSnapshot } from './storage';

export type DesktopStartupMode =
  | 'fresh_install'
  | 'migrated_from_localstorage'
  | 'already_migrated'
  | 'not_needed';

export type DesktopStartupFailureReason =
  | 'database_unhealthy'
  | 'conflict_existing_data'
  | 'migration_failed'
  | 'hydration_failed';

export interface HydratedDesktopWorkspace {
  businessProfile: BusinessProfile;
  clients: Client[];
  quotations: Quotation[];
  invoices: Invoice[];
  activities: ActivityLog[];
  themePreference: ThemeMode | null;
}

export interface DesktopStartupFailure {
  status: 'failed';
  reason: DesktopStartupFailureReason;
  title: string;
  message: string;
  suggestedAction: string;
  databaseStatus: DatabaseStatus | null;
  migrationStatus: MigrationStatusDto | null;
  existingCounts: MigrationCountsDto | null;
  backup: BackupLegacyStorageResult | null;
  diagnostics: MigrationDiagnosticDto[];
}

export interface DesktopStartupReady {
  status: 'ready';
  startupMode: DesktopStartupMode;
  databaseStatus: DatabaseStatus;
  migrationStatus: MigrationStatusDto;
  backup: BackupLegacyStorageResult | null;
  diagnostics: MigrationDiagnosticDto[];
  hydrated: HydratedDesktopWorkspace;
}

export type DesktopStartupResult = DesktopStartupReady | DesktopStartupFailure;

export interface DesktopStartupDeps {
  initializeDatabase: () => Promise<DatabaseStatus | null>;
  getDatabaseStatus: () => Promise<DatabaseStatus | null>;
  getMigrationStatus: () => Promise<MigrationStatusDto>;
  markMigrationNotNeeded: (source?: string | null) => Promise<MigrationStatusDto>;
  recordMigrationError: (diagnostic: MigrationDiagnosticDto) => Promise<MigrationDiagnosticDto>;
  getRawSnapshot: () => RawLegacyStorageSnapshot;
  runMigration: (options?: RunMigrationOptions) => Promise<ExplicitMigrationOutcome>;
  adapter: PersistenceAdapter;
  now?: () => string;
}

export interface RunDesktopStartupOptions {
  deps?: Partial<DesktopStartupDeps>;
  nowIso?: string;
}

function parseCount(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function hasExistingBusinessRows(counts: MigrationCountsDto | null | undefined): boolean {
  if (!counts) return false;
  return (
    parseCount(counts.localProfiles) > 0 ||
    parseCount(counts.businesses) > 0 ||
    parseCount(counts.businessAssets) > 0 ||
    parseCount(counts.clients) > 0 ||
    parseCount(counts.quotations) > 0 ||
    parseCount(counts.quotationItems) > 0 ||
    parseCount(counts.invoices) > 0 ||
    parseCount(counts.invoiceItems) > 0 ||
    parseCount(counts.payments) > 0 ||
    parseCount(counts.activityLogs) > 0
  );
}

function sanitizeUiErrorText(raw: string, maxChars = 320): string {
  const redactedDataUri = raw.replace(/data:[^\s]+/gi, '[REDACTED_DATA_URI]');
  const singleLine = redactedDataUri.replace(/[\r\n]+/g, ' ').trim();
  if (!singleLine) return 'Unexpected desktop database error.';
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 3)}...` : singleLine;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (isDatabaseCommandError(err)) {
    return sanitizeUiErrorText(err.message || fallback);
  }
  if (err instanceof Error) {
    return sanitizeUiErrorText(err.message || fallback);
  }
  if (typeof err === 'string' && err.trim()) {
    return sanitizeUiErrorText(err);
  }
  return fallback;
}

function extractValidThemeFromSnapshot(snapshot: RawLegacyStorageSnapshot): ThemeMode | null {
  const entry = snapshot.entries.find((e) => e.key === THEME_STORAGE_KEY);
  if (!entry || !entry.present || !entry.rawValue) return null;

  let candidate: unknown = entry.rawValue.trim();
  if (typeof candidate === 'string' && candidate.startsWith('"') && candidate.endsWith('"')) {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return isValidThemeMode(candidate) ? candidate : null;
}

function buildDiagnosticForFailure(params: {
  code: string;
  stage: MigrationDiagnosticDto['stage'];
  entityType: string;
  message: string;
  suggestedAction: string;
  recordId?: string | null;
}): MigrationDiagnosticDto {
  return {
    code: params.code.trim() || 'MIGRATION_FAILED',
    severity: 'error',
    stage: params.stage,
    entityType: params.entityType.trim() || 'workspace',
    recordId: params.recordId ?? null,
    field: null,
    originalValue: null,
    message: sanitizeUiErrorText(params.message, 400),
    suggestedAction: sanitizeUiErrorText(params.suggestedAction, 400),
  };
}

async function recordDiagnosticSafely(
  recordFn: (diagnostic: MigrationDiagnosticDto) => Promise<MigrationDiagnosticDto>,
  diagnostic: MigrationDiagnosticDto
): Promise<void> {
  try {
    const safeDiagnostic: MigrationDiagnosticDto = {
      code: diagnostic.code?.trim() || 'MIGRATION_FAILED',
      severity: 'error',
      stage: diagnostic.stage || 'sqlite_import',
      entityType: diagnostic.entityType?.trim() || 'workspace',
      recordId: diagnostic.recordId ?? null,
      field: diagnostic.field ?? null,
      originalValue: diagnostic.originalValue ?? null,
      message: sanitizeUiErrorText(diagnostic.message || 'Migration failed.', 400),
      suggestedAction: sanitizeUiErrorText(
        diagnostic.suggestedAction ||
          'Inspect diagnostics and retry initialization. Original LocalStorage data and backups remain untouched.',
        400
      ),
    };
    await recordFn(safeDiagnostic);
  } catch {
    // Diagnostic recording failure must never overwrite or mask the original failure
  }
}

async function hydrateWorkspaceFromAdapter(
  adapter: PersistenceAdapter
): Promise<HydratedDesktopWorkspace> {
  const [businessProfile, clients, quotations, invoices, activities, rawTheme] = await Promise.all([
    adapter.getBusinessProfile(),
    adapter.getClients(),
    adapter.getQuotations(),
    adapter.getInvoices(),
    adapter.getActivities(),
    adapter.getAppSetting<unknown>('theme_preference'),
  ]);

  return {
    businessProfile,
    clients,
    quotations,
    invoices,
    activities,
    themePreference: isValidThemeMode(rawTheme) ? rawTheme : null,
  };
}

async function initializeEmptyStarterWorkspace(
  deps: DesktopStartupDeps,
  snapshot: RawLegacyStorageSnapshot | null,
  markSource: string
): Promise<MigrationStatusDto> {
  // Record `not_needed` BEFORE creating starter business rows, because
  // `mark_migration_not_needed` strictly refuses once business data exists.
  await deps.markMigrationNotNeeded(markSource);

  await deps.adapter.clearAllData();

  if (snapshot) {
    const legacyTheme = extractValidThemeFromSnapshot(snapshot);
    if (legacyTheme) {
      await deps.adapter.saveAppSetting('theme_preference', legacyTheme);
    }
  }

  return deps.getMigrationStatus();
}

export function createDefaultDesktopStartupDeps(adapter: PersistenceAdapter): DesktopStartupDeps {
  return {
    initializeDatabase: () => DesktopDatabaseService.initializeDesktopDatabase(),
    getDatabaseStatus: () => DesktopDatabaseService.getDesktopDatabaseStatus(),
    getMigrationStatus: () => DesktopDatabaseService.getMigrationStatus(),
    markMigrationNotNeeded: (source) => DesktopDatabaseService.markMigrationNotNeeded(source),
    recordMigrationError: (diagnostic) => DesktopDatabaseService.recordMigrationError(diagnostic),
    // Strictly read-only LocalStorage snapshot (never triggers StorageService.init())
    getRawSnapshot: () => StorageService.getRawMigrationSnapshot(),
    runMigration: (options) => runExplicitLocalStorageMigration(options),
    adapter,
    now: () => new Date().toISOString(),
  };
}

/**
 * Mandatory Stage 2.2.4 Step 4 Desktop Startup Gate.
 *
 * Guarantees:
 * 1. SQLite health (`initialized`, `integrityOk`, `foreignKeyCheckPassed`) is verified before unlock.
 * 2. Migration state (`absent`, `not_needed`, `completed`, `conflict_existing_data`) is strictly respected.
 * 3. Conflicts and failures STOP immediately without overwriting SQLite or falling back to LocalStorage.
 * 4. Original LocalStorage data is never deleted or modified.
 * 5. Workspace state and theme preference are hydrated from SQLite before UI unlock.
 */
export async function runDesktopStartupGate(
  adapter: PersistenceAdapter,
  options?: RunDesktopStartupOptions
): Promise<DesktopStartupResult> {
  const defaultDeps = createDefaultDesktopStartupDeps(adapter);
  const deps: DesktopStartupDeps = {
    ...defaultDeps,
    ...options?.deps,
    adapter: options?.deps?.adapter ?? adapter,
  };
  const nowIso = options?.nowIso ?? deps.now?.() ?? new Date().toISOString();

  // Step 1: Verify SQLite database health before anything else
  let dbStatus: DatabaseStatus | null = null;
  try {
    dbStatus = await deps.initializeDatabase();
    if (!dbStatus) {
      dbStatus = await deps.getDatabaseStatus();
    }
  } catch (err) {
    return {
      status: 'failed',
      reason: 'database_unhealthy',
      title: 'Desktop Database Unavailable',
      message: extractErrorMessage(err, 'Could not initialize the desktop SQLite database.'),
      suggestedAction:
        'Ensure the application data directory is writable and not locked by another process, then retry initialization.',
      databaseStatus: null,
      migrationStatus: null,
      existingCounts: null,
      backup: null,
      diagnostics: [],
    };
  }

  if (
    !dbStatus ||
    !dbStatus.initialized ||
    !dbStatus.integrityOk ||
    !dbStatus.foreignKeyCheckPassed
  ) {
    return {
      status: 'failed',
      reason: 'database_unhealthy',
      title: 'SQLite Database Health Check Failed',
      message: !dbStatus
        ? 'Desktop SQLite database status could not be verified.'
        : `Database checks failed (initialized=${String(dbStatus.initialized)}, integrityOk=${String(dbStatus.integrityOk)}, foreignKeyCheckPassed=${String(dbStatus.foreignKeyCheckPassed)}).`,
      suggestedAction:
        'Do not modify files manually. Close conflicting processes or restore a verified backup before retrying.',
      databaseStatus: dbStatus,
      migrationStatus: null,
      existingCounts: null,
      backup: null,
      diagnostics: [],
    };
  }

  // Step 2: Check SQLite migration marker & row counts
  let migrationStatus: MigrationStatusDto;
  try {
    migrationStatus = await deps.getMigrationStatus();
  } catch (err) {
    return {
      status: 'failed',
      reason: 'database_unhealthy',
      title: 'Could Not Read Migration Status',
      message: extractErrorMessage(err, 'Failed to read SQLite migration metadata.'),
      suggestedAction: 'Retry database initialization or inspect SQLite file permissions.',
      databaseStatus: dbStatus,
      migrationStatus: null,
      existingCounts: null,
      backup: null,
      diagnostics: [],
    };
  }

  // Step 3: Conflict Guard — stop immediately if SQLite contains unmarked data or conflict marker
  if (
    migrationStatus.state === 'conflict_existing_data' ||
    (migrationStatus.state === 'absent' && hasExistingBusinessRows(migrationStatus.existingCounts))
  ) {
    return {
      status: 'failed',
      reason: 'conflict_existing_data',
      title: 'Existing SQLite Workspace Conflict Detected',
      message:
        'SQLite already contains business records without a verified migration marker. Startup stopped automatically to prevent overwriting existing data.',
      suggestedAction:
        'Inspect or back up your existing desktop SQLite database before clearing or resolving the conflict. Your browser LocalStorage data was not modified.',
      databaseStatus: dbStatus,
      migrationStatus,
      existingCounts: migrationStatus.existingCounts,
      backup: null,
      diagnostics: migrationStatus.lastError ? [migrationStatus.lastError] : [],
    };
  }

  let startupMode: DesktopStartupMode;
  let backup: BackupLegacyStorageResult | null = null;
  let diagnostics: MigrationDiagnosticDto[] = [];
  let resolvedMigrationStatus = migrationStatus;

  // Step 4: Branch strictly on verified SQLite migration marker state
  if (migrationStatus.state === 'completed') {
    if (parseCount(migrationStatus.existingCounts.businesses) === 0) {
      const diag = buildDiagnosticForFailure({
        code: 'MISSING_MIGRATED_WORKSPACE',
        stage: 'verify',
        entityType: 'business',
        message:
          'Migration marker indicates completed state, but no active business profile exists in SQLite.',
        suggestedAction:
          'Restore a verified workspace backup or inspect database state before continuing.',
      });
      return {
        status: 'failed',
        reason: 'hydration_failed',
        title: 'Desktop Workspace Integrity Issue',
        message: diag.message,
        suggestedAction: diag.suggestedAction,
        databaseStatus: dbStatus,
        migrationStatus,
        existingCounts: migrationStatus.existingCounts,
        backup: null,
        diagnostics: [diag],
      };
    }
    startupMode = 'already_migrated';
  } else if (migrationStatus.state === 'not_needed') {
    try {
      if (parseCount(migrationStatus.existingCounts.businesses) === 0) {
        await deps.adapter.clearAllData();
        resolvedMigrationStatus = await deps.getMigrationStatus();
      }
      startupMode = 'not_needed';
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to prepare clean desktop workspace.');
      const diag = buildDiagnosticForFailure({
        code: 'WORKSPACE_INIT_FAILED',
        stage: 'sqlite_import',
        entityType: 'business',
        message,
        suggestedAction: 'Retry initialization or verify SQLite write permissions.',
      });
      await recordDiagnosticSafely(deps.recordMigrationError, diag);
      return {
        status: 'failed',
        reason: 'hydration_failed',
        title: 'Workspace Initialization Failed',
        message,
        suggestedAction: diag.suggestedAction,
        databaseStatus: dbStatus,
        migrationStatus,
        existingCounts: migrationStatus.existingCounts,
        backup: null,
        diagnostics: [diag],
      };
    }
  } else {
    // migrationStatus.state === 'absent' with zero business rows
    let snapshot: RawLegacyStorageSnapshot;
    try {
      snapshot = deps.getRawSnapshot();
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to read legacy LocalStorage snapshot.');
      const diag = buildDiagnosticForFailure({
        code: 'SNAPSHOT_READ_FAILED',
        stage: 'extract',
        entityType: 'workspace',
        message,
        suggestedAction: 'Retry startup or check WebView storage availability.',
      });
      await recordDiagnosticSafely(deps.recordMigrationError, diag);
      return {
        status: 'failed',
        reason: 'migration_failed',
        title: 'Legacy Data Capture Failed',
        message,
        suggestedAction: diag.suggestedAction,
        databaseStatus: dbStatus,
        migrationStatus,
        existingCounts: migrationStatus.existingCounts,
        backup: null,
        diagnostics: [diag],
      };
    }

    const classification = classifyWorkspace(snapshot);

    if (classification === 'empty_fresh_install') {
      try {
        resolvedMigrationStatus = await initializeEmptyStarterWorkspace(
          deps,
          snapshot,
          'desktop_fresh_install'
        );
        startupMode = 'fresh_install';
      } catch (err) {
        const message = extractErrorMessage(
          err,
          'Failed to initialize fresh desktop SQLite workspace.'
        );
        const diag = buildDiagnosticForFailure({
          code: 'FRESH_WORKSPACE_INIT_FAILED',
          stage: 'sqlite_import',
          entityType: 'workspace',
          message,
          suggestedAction: 'Check SQLite write permissions and retry startup.',
        });
        await recordDiagnosticSafely(deps.recordMigrationError, diag);
        return {
          status: 'failed',
          reason: 'migration_failed',
          title: 'Fresh Workspace Initialization Failed',
          message,
          suggestedAction: diag.suggestedAction,
          databaseStatus: dbStatus,
          migrationStatus,
          existingCounts: migrationStatus.existingCounts,
          backup: null,
          diagnostics: [diag],
        };
      }
    } else {
      // Non-empty legacy LocalStorage snapshot (legacy user data, demo_seed_only, or partial/corrupted)
      try {
        const migrationDeps: MigrationRunnerDeps = {
          getRawSnapshot: () => snapshot,
          getMigrationStatus: () => deps.getMigrationStatus(),
        };

        const outcome = await deps.runMigration({
          nowIso,
          deps: options?.deps?.runMigration ? undefined : migrationDeps,
        });

        diagnostics = outcome.diagnostics ?? [];

        if (outcome.outcome === 'completed') {
          backup = outcome.backup;
          resolvedMigrationStatus = await deps.getMigrationStatus();
          if (resolvedMigrationStatus.state !== 'completed') {
            throw new Error(
              `Expected completed migration marker after import, got '${resolvedMigrationStatus.state}'.`
            );
          }
          startupMode = 'migrated_from_localstorage';
        } else if (outcome.outcome === 'already_completed') {
          resolvedMigrationStatus = outcome.status;
          startupMode = 'already_migrated';
        } else if (outcome.outcome === 'conflict_existing_data') {
          return {
            status: 'failed',
            reason: 'conflict_existing_data',
            title: 'Existing SQLite Workspace Conflict Detected',
            message:
              'SQLite already contains unmigrated data. Migration stopped to prevent overwriting existing records.',
            suggestedAction:
              'Resolve or back up the existing desktop database before retrying. Original LocalStorage remains untouched.',
            databaseStatus: dbStatus,
            migrationStatus: outcome.status,
            existingCounts: outcome.status.existingCounts,
            backup: null,
            diagnostics,
          };
        } else if (outcome.outcome === 'empty_fresh_install') {
          resolvedMigrationStatus = await initializeEmptyStarterWorkspace(
            deps,
            snapshot,
            'desktop_fresh_install'
          );
          startupMode = 'fresh_install';
        } else if (outcome.outcome === 'demo_seed_only') {
          // Raw backup was already created and verified; original LocalStorage stays intact.
          // Do not import unmodified demo seed records; mark not_needed and create clean empty starter workspace.
          backup = outcome.backup;
          resolvedMigrationStatus = await initializeEmptyStarterWorkspace(
            deps,
            snapshot,
            'desktop_demo_seed_only'
          );
          startupMode = 'fresh_install';
        } else if (outcome.outcome === 'backup_failed') {
          const primaryDiag =
            diagnostics.find((d) => d.severity === 'error') ??
            buildDiagnosticForFailure({
              code: 'BACKUP_FAILED',
              stage: 'backup',
              entityType: 'backup',
              message: 'Could not create and verify a raw LocalStorage backup before migration.',
              suggestedAction:
                'Check disk space and app data directory permissions, then retry initialization.',
            });
          await recordDiagnosticSafely(deps.recordMigrationError, primaryDiag);
          return {
            status: 'failed',
            reason: 'migration_failed',
            title: 'Pre-Migration Backup Failed',
            message: primaryDiag.message,
            suggestedAction: primaryDiag.suggestedAction,
            databaseStatus: dbStatus,
            migrationStatus,
            existingCounts: migrationStatus.existingCounts,
            backup: null,
            diagnostics: diagnostics.length > 0 ? diagnostics : [primaryDiag],
          };
        } else {
          // outcome === 'validation_failed'
          backup = outcome.backup;
          const primaryDiag =
            diagnostics.find((d) => d.severity === 'error') ??
            buildDiagnosticForFailure({
              code: 'MIGRATION_VALIDATION_FAILED',
              stage: 'validate',
              entityType: 'workspace',
              message:
                'Legacy LocalStorage records failed validation and were not imported into SQLite.',
              suggestedAction:
                'Review the diagnostic details below. Your raw backup and original LocalStorage data remain intact.',
            });
          await recordDiagnosticSafely(deps.recordMigrationError, primaryDiag);
          return {
            status: 'failed',
            reason: 'migration_failed',
            title: 'Legacy Data Validation Failed',
            message: primaryDiag.message,
            suggestedAction: primaryDiag.suggestedAction,
            databaseStatus: dbStatus,
            migrationStatus,
            existingCounts: migrationStatus.existingCounts,
            backup,
            diagnostics: diagnostics.length > 0 ? diagnostics : [primaryDiag],
          };
        }
      } catch (err) {
        const message = extractErrorMessage(
          err,
          'Desktop SQLite migration transaction failed and rolled back safely.'
        );
        const diag = buildDiagnosticForFailure({
          code: 'SQLITE_MIGRATION_FAILED',
          stage: 'sqlite_import',
          entityType: 'workspace',
          message,
          suggestedAction:
            'No partial migration records were committed. Your original LocalStorage data and any created backup remain preserved. Retry startup after resolving the issue.',
        });
        await recordDiagnosticSafely(deps.recordMigrationError, diag);
        return {
          status: 'failed',
          reason: 'migration_failed',
          title: 'LocalStorage-to-SQLite Migration Failed',
          message,
          suggestedAction: diag.suggestedAction,
          databaseStatus: dbStatus,
          migrationStatus,
          existingCounts: migrationStatus.existingCounts,
          backup,
          diagnostics: diagnostics.length > 0 ? diagnostics : [diag],
        };
      }
    }
  }

  // Step 5: Hydrate all workspace state & theme preference exclusively from SQLite BEFORE unlocking UI
  try {
    const hydrated = await hydrateWorkspaceFromAdapter(deps.adapter);
    return {
      status: 'ready',
      startupMode,
      databaseStatus: dbStatus,
      migrationStatus: resolvedMigrationStatus,
      backup,
      diagnostics,
      hydrated,
    };
  } catch (err) {
    const message = extractErrorMessage(
      err,
      'SQLite workspace was initialized, but records could not be hydrated.'
    );
    const diag = buildDiagnosticForFailure({
      code: 'SQLITE_HYDRATION_FAILED',
      stage: 'verify',
      entityType: 'workspace',
      message,
      suggestedAction: 'Retry initialization to reload your workspace from SQLite.',
    });
    return {
      status: 'failed',
      reason: 'hydration_failed',
      title: 'Failed to Load Desktop Workspace',
      message,
      suggestedAction: diag.suggestedAction,
      databaseStatus: dbStatus,
      migrationStatus: resolvedMigrationStatus,
      existingCounts: resolvedMigrationStatus.existingCounts,
      backup,
      diagnostics: [diag],
    };
  }
}
