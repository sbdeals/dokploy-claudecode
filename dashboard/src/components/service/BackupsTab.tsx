"use client";

/**
 * Backups tab for databases: configure an S3 destination, schedule backups
 * (cron), run one on demand, and restore from a stored dump. Thin UI over the
 * server actions in app/actions.ts, which wrap Dokploy's `destination.*` and
 * `backup.*` procedures. Restore is destructive and confirms first.
 *
 * Only the four dumpable engines are supported — Dokploy has no Redis backup.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  Archive,
  CloudUpload,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { Database, S3Destination, DatabaseBackup, BackupFile } from "@/lib/dokploy";
import {
  listDestinationsAction,
  createDestinationAction,
  testDestinationAction,
  removeDestinationAction,
  listDatabaseBackupsAction,
  createDatabaseBackupAction,
  updateDatabaseBackupAction,
  removeDatabaseBackupAction,
  runDatabaseBackupAction,
  listBackupFilesAction,
  restoreBackupAction,
} from "@/app/actions";
import { inputCls, Field, useSavedFlash } from "@/components/service/primitives";
import { cn } from "@/lib/utils";

export function BackupsTab({ db }: { db: Database }) {
  if (db.engine === "redis") {
    return (
      <p className="text-xs text-[var(--color-fg-subtle)]">
        Scheduled backups aren&apos;t available for Redis — Dokploy only backs up
        Postgres, MySQL, MariaDB and MongoDB.
      </p>
    );
  }
  // Narrowed: every branch below is a dumpable engine.
  return <BackupsPanel db={db} engine={db.engine} />;
}

type BackupEngine = Exclude<Database["engine"], "redis">;

function BackupsPanel({ db, engine }: { db: Database; engine: BackupEngine }) {
  const [destinations, setDestinations] = useState<S3Destination[]>([]);
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [initialised, setInitialised] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [, startLoad] = useTransition();

  // The fetch + its state updates run inside startTransition so this stays safe
  // to call from the mount effect below (react-hooks/set-state-in-effect). The
  // returned promise resolves when the load settles, so the child sections can
  // still `await onChange()` after a mutation.
  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        startLoad(async () => {
          const [dRes, bRes] = await Promise.all([
            listDestinationsAction(),
            listDatabaseBackupsAction(engine, db.id),
          ]);
          let err: string | null = null;
          if (dRes.ok) setDestinations(dRes.destinations);
          else err = dRes.error;
          if (bRes.ok) setBackups(bRes.backups);
          else err = err ?? bRes.error;
          setLoadError(err);
          setInitialised(true);
          resolve();
        });
      }),
    [engine, db.id],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!initialised) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
        <Loader2 className="size-4 animate-spin" /> Loading backups…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadError && <p role="alert" className="text-xs text-[var(--color-danger)]">{loadError}</p>}

      <DestinationsSection destinations={destinations} onChange={refresh} />

      <ScheduleSection
        db={db}
        engine={engine}
        destinations={destinations}
        backups={backups}
        onChange={refresh}
      />

      <RestoreSection db={db} engine={engine} destinations={destinations} />
    </div>
  );
}

// --- destinations -----------------------------------------------------------

function DestinationsSection({
  destinations,
  onChange,
}: {
  destinations: S3Destination[];
  onChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3">
      <SectionTitle
        icon={<CloudUpload className="size-3.5" />}
        title="S3 destinations"
        hint={`${destinations.length} configured`}
      />

      {destinations.length > 0 ? (
        <div className="space-y-2">
          {destinations.map((d) => (
            <div
              key={d.destinationId}
              className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              <Archive className="size-3.5 text-[var(--color-brand)]" />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <span className="truncate text-[11px] text-[var(--color-fg-subtle)]">
                {d.bucket}
              </span>
              <button
                onClick={async () => {
                  if (confirm(`Remove destination "${d.name}"?`)) {
                    await removeDestinationAction(d.destinationId);
                    await onChange();
                  }
                }}
                aria-label={`Remove destination ${d.name}`}
                className="shrink-0 rounded-md p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)]"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-fg-subtle)]">
          No destinations yet — add an S3-compatible bucket to store backups.
        </p>
      )}

      {open ? (
        <DestinationForm
          onDone={async () => {
            setOpen(false);
            await onChange();
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <button
          onClick={() => setOpen(true)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
        >
          <Plus className="size-3.5" /> Add destination
        </button>
      )}
    </section>
  );
}

function DestinationForm({
  onDone,
  onCancel,
}: {
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("AWS");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  const input = { name, provider, endpoint, region, bucket, accessKey, secretAccessKey };
  const complete =
    name.trim() && endpoint.trim() && region.trim() && bucket.trim() && accessKey.trim() && secretAccessKey.trim();

  function test() {
    setError(null);
    setTested(null);
    start(async () => {
      const res = await testDestinationAction(input);
      if (res.ok) setTested("Connection OK");
      else setError(res.error);
    });
  }
  function save() {
    setError(null);
    start(async () => {
      const res = await createDestinationAction(input);
      if (res.ok) await onDone();
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-backups" className={inputCls} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className={inputCls}>
            {["AWS", "Cloudflare", "DigitalOcean", "Backblaze", "Wasabi", "MinIO", "Other"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Region">
          <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" className={inputCls} />
        </Field>
      </div>
      <Field label="Endpoint" hint="S3 API URL">
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://s3.amazonaws.com"
          className={inputCls}
        />
      </Field>
      <Field label="Bucket">
        <input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-bucket" className={inputCls} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Access key">
          <input
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            autoComplete="off"
            className={inputCls}
          />
        </Field>
        <Field label="Secret key">
          <input
            type="password"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            autoComplete="off"
            className={inputCls}
          />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2">
        {error && <span role="alert" className="mr-auto text-xs text-[var(--color-danger)]">{error}</span>}
        {tested && <span role="status" className="mr-auto text-xs text-[var(--color-ok)]">{tested}</span>}
        <button onClick={onCancel} className="rounded-lg px-3 py-2 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
          Cancel
        </button>
        <button
          onClick={test}
          disabled={pending || !complete}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-40"
        >
          {pending && <Loader2 className="size-3.5 animate-spin" />} Test
        </button>
        <button
          onClick={save}
          disabled={pending || !complete}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-strong)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-brand-deep)] disabled:opacity-40"
        >
          Save destination
        </button>
      </div>
    </div>
  );
}

// --- schedules --------------------------------------------------------------

function ScheduleSection({
  db,
  engine,
  destinations,
  backups,
  onChange,
}: {
  db: Database;
  engine: BackupEngine;
  destinations: S3Destination[];
  backups: DatabaseBackup[];
  onChange: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  async function runRow(fn: () => Promise<{ ok: boolean; error?: string }>, id: string) {
    setBusyId(id);
    setRowError(null);
    const res = await fn();
    if (!res.ok) setRowError(res.error ?? "Failed");
    setBusyId(null);
    await onChange();
  }

  return (
    <section className="space-y-3">
      <SectionTitle icon={<Archive className="size-3.5" />} title="Scheduled backups" />

      {backups.length > 0 ? (
        <div className="space-y-2">
          {backups.map((b) => (
            <div
              key={b.backupId}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    b.enabled ? "bg-[var(--color-ok)]" : "bg-[var(--color-idle)]"
                  )}
                />
                <span className="sr-only">{b.enabled ? "Enabled" : "Disabled"}</span>
                <code className="font-mono text-xs text-[var(--color-fg)]">{b.schedule}</code>
                <span className="ml-auto truncate text-[11px] text-[var(--color-fg-subtle)]">
                  {b.destinationName ?? b.destinationId} · {b.prefix}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <RowBtn
                  disabled={busyId === b.backupId}
                  onClick={() => runRow(() => runDatabaseBackupAction(engine, b.backupId), b.backupId)}
                >
                  {busyId === b.backupId ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  Back up now
                </RowBtn>
                <RowBtn
                  disabled={busyId === b.backupId}
                  onClick={() =>
                    runRow(
                      () =>
                        updateDatabaseBackupAction({
                          backupId: b.backupId,
                          engine,
                          destinationId: b.destinationId,
                          database: b.database,
                          schedule: b.schedule,
                          prefix: b.prefix,
                          enabled: !b.enabled,
                          keepLatestCount: b.keepLatestCount,
                        }),
                      b.backupId
                    )
                  }
                >
                  {b.enabled ? "Disable" : "Enable"}
                </RowBtn>
                <RowBtn
                  disabled={busyId === b.backupId}
                  onClick={() => {
                    if (confirm("Remove this backup schedule?"))
                      void runRow(() => removeDatabaseBackupAction(b.backupId), b.backupId);
                  }}
                >
                  <Trash2 className="size-3.5" /> Remove
                </RowBtn>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-fg-subtle)]">No backup schedules yet.</p>
      )}
      {rowError && <p role="alert" className="text-xs text-[var(--color-danger)]">{rowError}</p>}

      {destinations.length > 0 ? (
        <NewScheduleForm db={db} engine={engine} destinations={destinations} onChange={onChange} />
      ) : (
        <p className="text-xs text-[var(--color-fg-subtle)]">
          Add a destination above before scheduling a backup.
        </p>
      )}
    </section>
  );
}

function NewScheduleForm({
  db,
  engine,
  destinations,
  onChange,
}: {
  db: Database;
  engine: BackupEngine;
  destinations: S3Destination[];
  onChange: () => Promise<void>;
}) {
  const [destinationId, setDestinationId] = useState(destinations[0]?.destinationId ?? "");
  const [database, setDatabase] = useState(db.databaseName ?? "");
  const [schedule, setSchedule] = useState("0 5 * * *");
  const [prefix, setPrefix] = useState(`/${db.appName || db.name}/`);
  const [keep, setKeep] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const complete = destinationId && database.trim() && schedule.trim() && prefix.trim();

  function create() {
    setError(null);
    start(async () => {
      const res = await createDatabaseBackupAction({
        engine,
        databaseId: db.id,
        destinationId,
        database: database.trim(),
        schedule: schedule.trim(),
        prefix: prefix.trim(),
        enabled,
        keepLatestCount: keep ? Number(keep) : null,
      });
      if (res.ok) await onChange();
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Destination">
          <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} className={inputCls}>
            {destinations.map((d) => (
              <option key={d.destinationId} value={d.destinationId}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Database" hint="name to dump">
          <input value={database} onChange={(e) => setDatabase(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Schedule" hint="cron">
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Keep latest" hint="blank = all">
          <input
            value={keep}
            onChange={(e) => setKeep(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="all"
            className={inputCls}
          />
        </Field>
      </div>
      <Field label="Prefix" hint="S3 key prefix">
        <input value={prefix} onChange={(e) => setPrefix(e.target.value)} className={inputCls} />
      </Field>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (run on schedule)
        </label>
        <div className="flex items-center gap-2">
          {error && <span role="alert" className="text-xs text-[var(--color-danger)]">{error}</span>}
          <button
            onClick={create}
            disabled={pending || !complete}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-strong)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-brand-deep)] disabled:opacity-40"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Create schedule
          </button>
        </div>
      </div>
    </div>
  );
}

// --- restore ----------------------------------------------------------------

function RestoreSection({
  db,
  engine,
  destinations,
}: {
  db: Database;
  engine: BackupEngine;
  destinations: S3Destination[];
}) {
  const [destinationId, setDestinationId] = useState(destinations[0]?.destinationId ?? "");
  const [search, setSearch] = useState("");
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [target, setTarget] = useState(db.databaseName ?? "");
  const [listing, startList] = useTransition();
  const [restoring, startRestore] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, flashDone] = useSavedFlash(3000);

  if (destinations.length === 0) return null;

  function loadFiles() {
    setError(null);
    setFiles(null);
    startList(async () => {
      const res = await listBackupFilesAction(destinationId, search);
      if (res.ok) setFiles(res.files.filter((f) => !f.isDir));
      else setError(res.error);
    });
  }

  function restore() {
    if (!selected || !target.trim()) return;
    if (
      !confirm(
        `Restore "${selected}" into ${target}? This overwrites the current database and cannot be undone.`
      )
    )
      return;
    setError(null);
    startRestore(async () => {
      const res = await restoreBackupAction({
        engine,
        databaseId: db.id,
        databaseName: target.trim(),
        backupFile: selected,
        destinationId,
      });
      if (res.ok) flashDone();
      else setError(res.error);
    });
  }

  return (
    <section className="space-y-3">
      <SectionTitle icon={<RotateCcw className="size-3.5" />} title="Restore" hint="destructive" />
      <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/40 p-3 space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Destination">
              <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} className={inputCls}>
                {destinations.map((d) => (
                  <option key={d.destinationId} value={d.destinationId}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Search" hint="path filter">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="prefix/" className={inputCls} />
            </Field>
          </div>
          <button
            onClick={loadFiles}
            disabled={listing || !destinationId}
            className="mb-0.5 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-40"
          >
            {listing ? <Loader2 className="size-3.5 animate-spin" /> : null} List files
          </button>
        </div>

        {files && (
          <Field label={`Backup file (${files.length})`}>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className={inputCls}>
              <option value="">Select a file…</option>
              {files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Restore into database">
          <input value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls} />
        </Field>

        <div className="flex items-center justify-end gap-2">
          {error && <span role="alert" className="mr-auto text-xs text-[var(--color-danger)]">{error}</span>}
          {done && <span role="status" className="mr-auto text-xs text-[var(--color-ok)]">Restore finished</span>}
          <button
            onClick={restore}
            disabled={restoring || !selected || !target.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-danger)]/50 px-3 py-2 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-40"
          >
            {restoring ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            Restore
          </button>
        </div>
      </div>
    </section>
  );
}

// --- shared bits ------------------------------------------------------------

function SectionTitle({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[var(--color-fg-muted)]">{icon}</span>
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h3>
      {hint && <span className="text-[10px] text-[var(--color-fg-subtle)]">{hint}</span>}
    </div>
  );
}

function RowBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}
