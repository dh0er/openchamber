import React, { useMemo, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { SourceUpdateFailureReport, UpdateInfo, UpdateProgress } from '@/lib/desktop';
import { useI18n, type I18nKey } from '@/lib/i18n';

type SourceUpdatePanelProps = {
  info: UpdateInfo;
  downloading: boolean;
  downloaded: boolean;
  progress: UpdateProgress | null;
  error: string | null;
  onDownload: () => void;
  onRestart: () => void;
};

const SOURCE_UPDATE_PHASE_KEYS: Readonly<Record<string, I18nKey>> = {
  verify: 'updateDialog.source.phase.verify',
  fetch: 'updateDialog.source.phase.fetch',
  'verify-bundle': 'updateDialog.source.phase.verifyBundle',
  rebase: 'updateDialog.source.phase.rebase',
  'install-dependencies': 'updateDialog.source.phase.installDependencies',
  test: 'updateDialog.source.phase.test',
  'type-check': 'updateDialog.source.phase.typeCheck',
  lint: 'updateDialog.source.phase.lint',
  build: 'updateDialog.source.phase.build',
  'prepare-installer': 'updateDialog.source.phase.prepareInstaller',
  ready: 'updateDialog.source.phase.ready',
};

const shortRevision = (revision: string | undefined): string | null => {
  const value = revision?.trim();
  return value ? value.slice(0, 10) : null;
};

const formatFailureReport = (report: SourceUpdateFailureReport, error: string | null): string => {
  return JSON.stringify({
    ...report,
    ...(error && error !== report.summary ? { error } : {}),
  }, null, 2);
};

export const SourceUpdatePanel: React.FC<SourceUpdatePanelProps> = ({
  info,
  downloading,
  downloaded,
  progress,
  error,
  onDownload,
  onRestart,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const report = progress?.report;
  const currentRevision = shortRevision(info.currentRevision);
  const targetRevision = shortRevision(info.targetRevision);
  const step = typeof progress?.step === 'number' ? progress.step : null;
  const stepCount = typeof progress?.stepCount === 'number' && progress.stepCount > 0
    ? progress.stepCount
    : null;
  const stepPercent = step !== null && stepCount !== null
    ? Math.min(100, Math.max(0, Math.round((step / stepCount) * 100)))
    : null;
  const phaseKey = progress?.phase ? SOURCE_UPDATE_PHASE_KEYS[progress.phase] : undefined;
  const progressLabel = phaseKey
    ? t(phaseKey)
    : downloaded
      ? t('updateDialog.source.status.ready')
      : t('updateDialog.source.status.preparing');

  const reportText = useMemo(
    () => report ? formatFailureReport(report, error) : '',
    [error, report],
  );

  const handleCopyReport = async () => {
    if (!reportText) return;
    const result = await copyTextToClipboard(reportText);
    if (!result.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t('updateDialog.source.description')}
      </p>

      {(currentRevision || targetRevision) && (
        <div className="grid gap-2 rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/30 p-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <div className="min-w-0">
            <div className="typography-meta text-muted-foreground">
              {t('updateDialog.source.revision.current')}
            </div>
            <code className="block truncate font-mono text-sm text-foreground" title={info.currentRevision}>
              {currentRevision || t('common.unavailable')}
            </code>
          </div>
          <span className="hidden text-muted-foreground/50 sm:block">&rarr;</span>
          <div className="min-w-0 sm:text-right">
            <div className="typography-meta text-muted-foreground">
              {t('updateDialog.source.revision.target')}
            </div>
            <code className="block truncate font-mono text-sm text-[var(--primary-base)]" title={info.targetRevision}>
              {targetRevision || t('common.unavailable')}
            </code>
          </div>
        </div>
      )}

      {(downloading || downloaded) && !report && !error && (
        <div
          className="space-y-3 rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/30 p-4"
          aria-live="polite"
        >
          <div className="flex min-w-0 items-start gap-3">
            {downloading ? (
              <Icon name="loader" className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--primary-base)]" />
            ) : (
              <Icon name="check" className="mt-0.5 size-4 shrink-0 text-[var(--status-success)]" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="typography-ui-label text-foreground">
                  {progressLabel}
                </span>
                {step !== null && stepCount !== null && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {t('updateDialog.source.status.step', { step, stepCount })}
                  </span>
                )}
              </div>
            </div>
          </div>
          {stepPercent !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-subtle)]">
              <div
                className="h-full bg-[var(--primary-base)] transition-all duration-300"
                style={{ width: `${stepPercent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {(report || error) && (
        <div className="space-y-3 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="typography-ui-label text-[var(--status-error)]">
                {t('updateDialog.source.report.title')}
              </div>
              <p className="mt-1 break-words text-sm text-foreground">
                {report?.summary || error}
              </p>
              {error && report && error !== report.summary && (
                <p className="mt-1 break-words text-xs text-muted-foreground">{error}</p>
              )}
            </div>
            {report && (
              <Button variant="outline" size="sm" onClick={handleCopyReport}>
                <Icon name={copied ? 'check' : 'clipboard'} className="size-4" />
                {copied
                  ? t('updateDialog.source.actions.reportCopied')
                  : t('updateDialog.source.actions.copyReport')}
              </Button>
            )}
          </div>

          {report && (
            <div className="space-y-3 text-sm">
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
                <dt className="text-muted-foreground">{t('updateDialog.source.report.stage')}</dt>
                <dd className="min-w-0 break-words font-mono text-foreground">{report.stage}</dd>
                {report.patchSubject && (
                  <>
                    <dt className="text-muted-foreground">{t('updateDialog.source.report.patch')}</dt>
                    <dd className="min-w-0 break-words text-foreground">{report.patchSubject}</dd>
                  </>
                )}
                {report.reportPath && (
                  <>
                    <dt className="text-muted-foreground">{t('updateDialog.source.report.path')}</dt>
                    <dd className="min-w-0 break-all font-mono text-xs text-foreground">{report.reportPath}</dd>
                  </>
                )}
              </dl>

              {report.conflictFiles.length > 0 && (
                <div>
                  <div className="mb-1.5 text-muted-foreground">
                    {t('updateDialog.source.report.conflicts')}
                  </div>
                  <ul className="space-y-1 rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/40 p-2">
                    {report.conflictFiles.map((file) => (
                      <li key={file} className="break-all font-mono text-xs text-foreground">{file}</li>
                    ))}
                  </ul>
                </div>
              )}

              {report.logTail && (
                <div>
                  <div className="mb-1.5 text-muted-foreground">
                    {t('updateDialog.source.report.log')}
                  </div>
                  <ScrollableOverlay className="max-h-40 rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]/60" fillContainer={false}>
                    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground">
                      {report.logTail}
                    </pre>
                  </ScrollableOverlay>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        {downloaded ? (
          <Button onClick={onRestart}>
            <Icon name="restart" className="size-4" />
            {t('updateDialog.source.actions.installRestart')}
          </Button>
        ) : (
          <Button onClick={onDownload} disabled={downloading}>
            <Icon name={downloading ? 'loader' : 'download'} className={downloading ? 'size-4 animate-spin' : 'size-4'} />
            {downloading
              ? t('updateDialog.source.status.preparing')
              : t('updateDialog.source.actions.prepare')}
          </Button>
        )}
      </div>
    </div>
  );
};
