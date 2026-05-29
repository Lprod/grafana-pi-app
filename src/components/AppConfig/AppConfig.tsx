import React, { ChangeEvent, FormEvent, useState } from 'react';
import {
  Button,
  Field,
  Input,
  useStyles2,
  FieldSet,
  SecretInput,
  MultiCombobox,
  TextArea,
  type ComboboxOption,
} from '@grafana/ui';
import { PluginConfigPageProps, AppPluginMeta, PluginMeta, GrafanaTheme2 } from '@grafana/data';
import { getBackendSrv, getDataSourceSrv, locationService } from '@grafana/runtime';
import { css } from '@emotion/css';
import { testIds } from '../testIds';
import { lastValueFrom } from 'rxjs';
import type { PiAppJsonData } from '../../types';

type State = {
  openAIBaseUrl: string;
  defaultModel: string;
  isOpenAIAPIKeySet: boolean;
  openAIAPIKey: string;
  allowedDatasourceUids: string[];
  systemPromptAddendum: string;
};

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<PiAppJsonData>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;
  const [state, setState] = useState<State>({
    openAIBaseUrl: jsonData?.openAIBaseUrl || 'https://api.openai.com/v1',
    defaultModel: jsonData?.defaultModel || 'gpt-4.1',
    openAIAPIKey: '',
    isOpenAIAPIKeySet: Boolean(jsonData?.isOpenAIAPIKeySet),
    allowedDatasourceUids: Array.isArray(jsonData?.allowedDatasourceUids) ? jsonData.allowedDatasourceUids : [],
    systemPromptAddendum: typeof jsonData?.systemPromptAddendum === 'string' ? jsonData.systemPromptAddendum : '',
  });
  const datasourceOptions = getPrometheusDatasourceOptions(state.allowedDatasourceUids);

  const isSubmitDisabled = Boolean(
    !state.openAIBaseUrl || !state.defaultModel || (!state.isOpenAIAPIKeySet && !state.openAIAPIKey)
  );

  const onResetOpenAIAPIKey = () =>
    setState({
      ...state,
      openAIAPIKey: '',
      isOpenAIAPIKeySet: false,
    });

  const onChangeOpenAIAPIKey = (event: ChangeEvent<HTMLInputElement>) => {
    setState({
      ...state,
      openAIAPIKey: event.target.value.trim(),
    });
  };

  const onChangeOpenAIBaseUrl = (event: ChangeEvent<HTMLInputElement>) => {
    setState({
      ...state,
      openAIBaseUrl: event.target.value.trim(),
    });
  };

  const onChangeDefaultModel = (event: ChangeEvent<HTMLInputElement>) => {
    setState({
      ...state,
      defaultModel: event.target.value.trim(),
    });
  };

  const onChangeAllowedDatasourceUids = (options: Array<ComboboxOption<string>>) => {
    setState({
      ...state,
      allowedDatasourceUids: options.map((option) => option.value),
    });
  };

  const onChangeSystemPromptAddendum = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setState({
      ...state,
      systemPromptAddendum: event.currentTarget.value,
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        openAIBaseUrl: state.openAIBaseUrl,
        defaultModel: state.defaultModel,
        isOpenAIAPIKeySet: true,
        allowedDatasourceUids: state.allowedDatasourceUids,
        systemPromptAddendum: state.systemPromptAddendum.trim(),
      },
      secureJsonData: state.isOpenAIAPIKeySet
        ? undefined
        : {
            openAIAPIKey: state.openAIAPIKey,
          },
    });
  };

  return (
    <form onSubmit={onSubmit}>
      <FieldSet label="OpenAI-compatible LLM" className={s.marginTopXl}>
        <Field label="API Key" description="Stored in secureJsonData and only used by the backend plugin.">
          <SecretInput
            width={60}
            data-testid={testIds.appConfig.openAIAPIKey}
            id="openai-api-key"
            value={state.openAIAPIKey}
            isConfigured={state.isOpenAIAPIKeySet}
            placeholder="sk-..."
            onChange={onChangeOpenAIAPIKey}
            onReset={onResetOpenAIAPIKey}
          />
        </Field>

        <Field
          label="Base URL"
          description="OpenAI-compatible API root, without /chat/completions."
          className={s.marginTop}
        >
          <Input
            width={60}
            id="openai-base-url"
            data-testid={testIds.appConfig.openAIBaseUrl}
            value={state.openAIBaseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={onChangeOpenAIBaseUrl}
          />
        </Field>

        <Field
          label="Model"
          description="Central model used for all assistant requests. Chat users cannot override it."
          className={s.marginTop}
        >
          <Input
            width={40}
            id="default-model"
            data-testid={testIds.appConfig.defaultModel}
            value={state.defaultModel}
            placeholder="gpt-4.1"
            onChange={onChangeDefaultModel}
          />
        </Field>

        <Field
          label="System prompt addendum"
          description="Optional central instructions appended after the built-in guardrails. Do not include secrets."
          className={s.marginTop}
        >
          <TextArea
            className={s.promptTextArea}
            data-testid={testIds.appConfig.systemPromptAddendum}
            id="system-prompt-addendum"
            rows={8}
            value={state.systemPromptAddendum}
            placeholder="Prefer concise incident summaries. Mention dashboard changes explicitly."
            onChange={onChangeSystemPromptAddendum}
          />
        </Field>

        <Field
          label="Allowed Prometheus datasources"
          description="Leave empty to allow all Prometheus datasources visible to the current Grafana user. Select datasources to restrict assistant discovery and queries."
          className={s.marginTop}
        >
          <MultiCombobox
            width={60}
            id="allowed-datasource-uids"
            data-testid={testIds.appConfig.allowedDatasourceUids}
            options={datasourceOptions}
            value={state.allowedDatasourceUids}
            placeholder="All visible Prometheus datasources"
            isClearable
            onChange={onChangeAllowedDatasourceUids}
          />
        </Field>

        <div className={s.marginTop}>
          <Button type="submit" data-testid={testIds.appConfig.submit} disabled={isSubmitDisabled}>
            Save LLM settings
          </Button>
        </div>
      </FieldSet>
    </form>
  );
};

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  colorWeak: css`
    color: ${theme.colors.text.secondary};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(3)};
  `,
  marginTopXl: css`
    margin-top: ${theme.spacing(6)};
  `,
  promptTextArea: css`
    max-width: 640px;
    width: 100%;
  `,
});

const updatePluginAndReload = async (pluginId: string, data: Partial<PluginMeta<PiAppJsonData>>) => {
  try {
    await updatePlugin(pluginId, data);

    // Reloading the page as the changes made here wouldn't be propagated to the actual plugin otherwise.
    // This is not ideal, however unfortunately currently there is no supported way for updating the plugin state.
    locationService.reload();
  } catch (e) {
    console.error('Error while updating the plugin', e);
  }
};

const getPrometheusDatasourceOptions = (selectedUids: string[]): Array<ComboboxOption<string>> => {
  const options = getDataSourceSrv()
    .getList({ metrics: true, type: 'prometheus' })
    .filter((ds) => Boolean(ds.uid))
    .map((ds) => ({
      label: ds.name,
      value: ds.uid,
      description: `${ds.uid}${ds.isDefault ? ' (default)' : ''}`,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const availableUids = new Set(options.map((option) => option.value));
  const missingOptions = selectedUids
    .filter((uid) => uid && !availableUids.has(uid))
    .map((uid) => ({
      label: uid,
      value: uid,
      description: 'Configured UID not visible in this session',
    }));

  return [...options, ...missingOptions];
};

const updatePlugin = async (pluginId: string, data: Partial<PluginMeta>) => {
  const response = getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });

  const dataResponse = await lastValueFrom(response);

  return dataResponse.data;
};
