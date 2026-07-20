import React from 'react';
import {
  SettingsStackedField,
  SettingsTwoColumn,
  SETTINGS_CLUSTER_CONTROL_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import {
  createDefaultProviderProxy,
  type ProviderProxyMode,
  type ProviderProxySettings,
} from './providerAvailability';

interface ProviderConnectionFormProps {
  name: string;
  apiKey: string;
  baseUrl: string;
  proxy?: ProviderProxySettings;
  baseUrlRequired?: boolean;
  showProxy?: boolean;
  apiKeyRequired: boolean;
  showApiKey?: boolean;
  busy: boolean;
  onNameChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onProxyChange?: (value: ProviderProxySettings) => void;
  onSubmit: () => void;
}

type ProviderIdentityFieldsProps = Pick<
  ProviderConnectionFormProps,
  'name' | 'baseUrl' | 'proxy' | 'baseUrlRequired' | 'showProxy' | 'onNameChange' | 'onBaseUrlChange' | 'onProxyChange'
>;

export const ProviderIdentityFields: React.FC<ProviderIdentityFieldsProps> = ({
  name,
  baseUrl,
  proxy = createDefaultProviderProxy(),
  baseUrlRequired = false,
  showProxy = true,
  onNameChange,
  onBaseUrlChange,
  onProxyChange,
}) => {
  const { t } = useI18n();

  return (
    <>
      <SettingsStackedField
        label={t('settings.providers.page.connect.instanceNameLabel')}
        info={t('settings.providers.page.connect.instanceNameTooltip')}
      >
        <Input
          aria-label={t('settings.providers.page.connect.instanceNameLabel')}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={t('settings.providers.page.connect.instanceNamePlaceholder')}
          className="h-8 min-w-0 flex-1"
          maxLength={120}
        />
      </SettingsStackedField>

      <SettingsStackedField
        label={baseUrlRequired
          ? t('settings.providers.page.auth.baseUrlRequiredLabel')
          : t('settings.providers.page.auth.baseUrlLabel')}
        info={baseUrlRequired
          ? t('settings.providers.page.auth.openaiCompatibleBaseUrlTooltip')
          : t('settings.providers.page.auth.baseUrlTooltip')}
      >
        <Input
          aria-label={baseUrlRequired
            ? t('settings.providers.page.auth.baseUrlRequiredLabel')
            : t('settings.providers.page.auth.baseUrlLabel')}
          type="url"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          placeholder={t('settings.providers.page.auth.baseUrlPlaceholder')}
          required={baseUrlRequired}
          aria-required={baseUrlRequired}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </SettingsStackedField>

      {showProxy && (
        <SettingsStackedField
          label={t('settings.providers.page.auth.proxyModeLabel')}
          info={t('settings.providers.page.auth.proxyModeTooltip')}
        >
          <Select<ProviderProxyMode>
            value={proxy.mode}
            onValueChange={(mode) => onProxyChange?.({
              mode,
              url: mode === 'manual' ? proxy.url : '',
            })}
          >
            <SelectTrigger
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_TRIGGER_CLASS}
              aria-label={t('settings.providers.page.auth.proxyModeLabel')}
            >
              <SelectValue>
                {(value) => {
                  if (value === 'system') return t('settings.providers.page.auth.proxyModeSystem');
                  if (value === 'manual') return t('settings.providers.page.auth.proxyModeManual');
                  return t('settings.providers.page.auth.proxyModeDirect');
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="direct">{t('settings.providers.page.auth.proxyModeDirect')}</SelectItem>
              <SelectItem value="system">{t('settings.providers.page.auth.proxyModeSystem')}</SelectItem>
              <SelectItem value="manual">{t('settings.providers.page.auth.proxyModeManual')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsStackedField>
      )}

      {showProxy && proxy.mode === 'manual' && (
        <SettingsStackedField
          label={t('settings.providers.page.auth.proxyUrlLabel')}
          info={t('settings.providers.page.auth.proxyUrlTooltip')}
        >
          <Input
            aria-label={t('settings.providers.page.auth.proxyUrlLabel')}
            type="url"
            value={proxy.url}
            onChange={(event) => onProxyChange?.({ ...proxy, url: event.target.value })}
            placeholder={t('settings.providers.page.auth.proxyUrlPlaceholder')}
            required
            aria-required
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </SettingsStackedField>
      )}
    </>
  );
};

export const ProviderConnectionForm: React.FC<ProviderConnectionFormProps> = ({
  name,
  apiKey,
  baseUrl,
  proxy = createDefaultProviderProxy(),
  baseUrlRequired = false,
  showProxy = true,
  apiKeyRequired,
  showApiKey = true,
  busy,
  onNameChange,
  onApiKeyChange,
  onBaseUrlChange,
  onProxyChange,
  onSubmit,
}) => {
  const { t } = useI18n();

  return (
    <SettingsTwoColumn className="gap-y-5">
      <ProviderIdentityFields
        name={name}
        baseUrl={baseUrl}
        proxy={proxy}
        baseUrlRequired={baseUrlRequired}
        showProxy={showProxy}
        onNameChange={onNameChange}
        onBaseUrlChange={onBaseUrlChange}
        onProxyChange={onProxyChange}
      />

      {showApiKey ? (
        <SettingsStackedField
          label={t('settings.providers.page.auth.apiKeyLabel')}
          info={t('settings.providers.page.auth.apiKeyTooltip')}
          className="@3xl:col-span-2"
          controlClassName="max-w-[24rem]"
        >
          <Input
            aria-label={t('settings.providers.page.auth.apiKeyLabel')}
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder={apiKeyRequired
              ? t('settings.providers.page.auth.apiKeyPlaceholder')
              : t('settings.providers.page.auth.apiKeyExistingPlaceholder')}
            className={`${SETTINGS_CLUSTER_CONTROL_CLASS} h-8 font-mono text-xs`}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button
            size="sm"
            className="shrink-0 !font-normal"
            onClick={onSubmit}
            disabled={busy}
          >
            {busy
              ? t('settings.providers.page.actions.saving')
              : apiKeyRequired
                ? t('settings.providers.page.actions.connectInstance')
                : t('settings.providers.page.actions.saveConnection')}
          </Button>
        </SettingsStackedField>
      ) : (
        <div className="flex justify-end @3xl:col-span-2">
          <Button
            size="sm"
            className="!font-normal"
            onClick={onSubmit}
            disabled={busy}
          >
            {busy
              ? t('settings.providers.page.actions.saving')
              : t('settings.providers.page.actions.saveConnection')}
          </Button>
        </div>
      )}
    </SettingsTwoColumn>
  );
};
