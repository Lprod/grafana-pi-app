import React, { ChangeEvent, FormEvent, useMemo, useState } from 'react';
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
import { parseCustomSkillsJson, validateCustomSkillsJson } from '../../pages/Chat/skills/configured';

type State = {
  openAIBaseUrl: string;
  defaultModel: string;
  isOpenAIAPIKeySet: boolean;
  openAIAPIKey: string;
  allowedPrometheusDatasourceUids: string[];
  allowedRqliteDatasourceUids: string[];
  systemPromptAddendum: string;
  customSkillsJson: string;
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
    allowedPrometheusDatasourceUids: Array.isArray(jsonData?.allowedPrometheusDatasourceUids)
      ? jsonData.allowedPrometheusDatasourceUids
      : [],
    allowedRqliteDatasourceUids: Array.isArray(jsonData?.allowedRqliteDatasourceUids)
      ? jsonData.allowedRqliteDatasourceUids
      : [],
    systemPromptAddendum: typeof jsonData?.systemPromptAddendum === 'string' ? jsonData.systemPromptAddendum : '',
    customSkillsJson: formatCustomSkillsJson(jsonData?.customSkills),
  });
  const datasourceOptions = getPrometheusDatasourceOptions(state.allowedPrometheusDatasourceUids);
  const rqliteDatasourceOptions = getRqliteDatasourceOptions(state.allowedRqliteDatasourceUids);
  const customSkillsError = useMemo(() => validateCustomSkillsJson(state.customSkillsJson), [state.customSkillsJson]);

  const isSubmitDisabled = Boolean(
    !state.openAIBaseUrl ||
    !state.defaultModel ||
    (!state.isOpenAIAPIKeySet && !state.openAIAPIKey) ||
    customSkillsError
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
      allowedPrometheusDatasourceUids: options.map((option) => option.value),
    });
  };

  const onChangeAllowedRqliteDatasourceUids = (options: Array<ComboboxOption<string>>) => {
    setState({
      ...state,
      allowedRqliteDatasourceUids: options.map((option) => option.value),
    });
  };

  const onChangeSystemPromptAddendum = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setState({
      ...state,
      systemPromptAddendum: event.currentTarget.value,
    });
  };

  const onChangeCustomSkillsJson = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setState({
      ...state,
      customSkillsJson: event.currentTarget.value,
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const customSkills = parseCustomSkillsJson(state.customSkillsJson);

    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        openAIBaseUrl: state.openAIBaseUrl,
        defaultModel: state.defaultModel,
        isOpenAIAPIKeySet: true,
        allowedPrometheusDatasourceUids: state.allowedPrometheusDatasourceUids,
        allowedRqliteDatasourceUids: state.allowedRqliteDatasourceUids,
        systemPromptAddendum: state.systemPromptAddendum.trim(),
        customSkills,
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
            id="allowed-prometheus-datasource-uids"
            data-testid={testIds.appConfig.allowedPrometheusDatasourceUids}
            options={datasourceOptions}
            value={state.allowedPrometheusDatasourceUids}
            placeholder="All visible Prometheus datasources"
            isClearable
            onChange={onChangeAllowedDatasourceUids}
          />
        </Field>

        <Field
          label="Allowed rqlite datasources"
          description="Leave empty to allow all rqlite datasources visible to the current Grafana user. Select datasources to restrict assistant SQL queries."
          className={s.marginTop}
        >
          <MultiCombobox
            width={60}
            id="allowed-rqlite-datasource-uids"
            data-testid={testIds.appConfig.allowedRqliteDatasourceUids}
            options={rqliteDatasourceOptions}
            value={state.allowedRqliteDatasourceUids}
            placeholder="All visible rqlite datasources"
            isClearable
            onChange={onChangeAllowedRqliteDatasourceUids}
          />
        </Field>
      </FieldSet>

      <FieldSet label="Custom skills" className={s.marginTopXl}>
        <Field
          label="Custom skills JSON"
          description="Optional non-secret skill definitions stored in jsonData. Users activate explicit skills with $skill-name."
          invalid={Boolean(customSkillsError)}
          error={customSkillsError}
        >
          <TextArea
            className={s.customSkillsTextArea}
            data-testid={testIds.appConfig.customSkillsJson}
            id="custom-skills-json"
            rows={14}
            value={state.customSkillsJson}
            placeholder={CUSTOM_SKILLS_PLACEHOLDER}
            onChange={onChangeCustomSkillsJson}
          />
        </Field>
      </FieldSet>

      <div className={s.marginTop}>
        <Button type="submit" data-testid={testIds.appConfig.submit} disabled={isSubmitDisabled}>
          Save LLM settings
        </Button>
      </div>
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
  customSkillsTextArea: css`
    max-width: 860px;
    width: 100%;
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
});

const CUSTOM_SKILLS_PLACEHOLDER = `[
  {
    "name": "team-runbook",
    "description": "Use the team incident workflow and dashboard conventions.",
    "content": "# Team Runbook\\n\\nCheck service SLOs first. Prefer existing dashboards before creating new ones.",
    "activation": {
      "explicitOnly": true
    },
    "toolGroups": ["metrics", "rqlite", "skillResources"],
    "resources": [
      {
        "path": "references/team-runbook.md",
        "content": "# Team Runbook\\n\\nEscalate unresolved paging incidents after 15 minutes."
      }
    ]
  }
]`;

function formatCustomSkillsJson(customSkills: PiAppJsonData['customSkills']) {
  if (!Array.isArray(customSkills) || customSkills.length === 0) {
    return '';
  }

  return JSON.stringify(customSkills, null, 2);
}

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

const getRqliteDatasourceOptions = (selectedUids: string[]): Array<ComboboxOption<string>> => {
  const options = getDataSourceSrv()
    .getList({ metrics: true, type: 'g42-rqlite-datasource' })
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
