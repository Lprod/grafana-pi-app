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
  RadioButtonGroup,
  type ComboboxOption,
} from '@grafana/ui';
import { PluginConfigPageProps, AppPluginMeta, PluginMeta, GrafanaTheme2 } from '@grafana/data';
import { getBackendSrv, getDataSourceSrv, locationService } from '@grafana/runtime';
import { css } from '@emotion/css';
import { testIds } from '../testIds';
import { lastValueFrom } from 'rxjs';
import type {
  PiAppAccessMode,
  PiAppCustomSkill,
  PiAppJsonData,
  PiAppThinkingFormat,
  PiAppThinkingLevel,
} from '../../types';
import { GRAFANA_SKILLS } from '../../pages/Chat/skills/catalog';
import { getConfiguredThinkingFormat, getConfiguredThinkingLevel } from '../../pages/Chat/model';
import {
  APP_ACCESS_ACTION,
  accessModeOptions,
  formatAllowedUsersInput,
  getConfiguredAccessMode,
  parseAllowedUsersInput,
} from '../../utils/access';
import { CustomSkillsEditor } from './CustomSkillsEditor';
import {
  formatCustomSkillValidationIssues,
  serializeCustomSkills,
  validateCustomSkillsForEditor,
} from './customSkillsEditorModel';

type State = {
  openAIBaseUrl: string;
  defaultModel: string;
  thinkingLevel: PiAppThinkingLevel;
  thinkingFormat: PiAppThinkingFormat;
  isOpenAIAPIKeySet: boolean;
  openAIAPIKey: string;
  accessMode: PiAppAccessMode;
  allowedUsersText: string;
  allowedPrometheusDatasourceUids: string[];
  systemPromptAddendum: string;
  customSkills: PiAppCustomSkill[];
};

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<PiAppJsonData>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;
  const [state, setState] = useState<State>({
    openAIBaseUrl: jsonData?.openAIBaseUrl || 'https://api.openai.com/v1',
    defaultModel: jsonData?.defaultModel || 'gpt-4.1',
    thinkingLevel: getConfiguredThinkingLevel(jsonData),
    thinkingFormat: getConfiguredThinkingFormat(jsonData),
    openAIAPIKey: '',
    isOpenAIAPIKeySet: Boolean(jsonData?.isOpenAIAPIKeySet),
    accessMode: getConfiguredAccessMode(jsonData),
    allowedUsersText: formatAllowedUsersInput(jsonData?.allowedUsers),
    allowedPrometheusDatasourceUids: Array.isArray(jsonData?.allowedPrometheusDatasourceUids)
      ? jsonData.allowedPrometheusDatasourceUids
      : [],
    systemPromptAddendum: typeof jsonData?.systemPromptAddendum === 'string' ? jsonData.systemPromptAddendum : '',
    customSkills: Array.isArray(jsonData?.customSkills) ? jsonData.customSkills : [],
  });
  const datasourceOptions = getPrometheusDatasourceOptions(state.allowedPrometheusDatasourceUids);
  const customSkillIssues = useMemo(
    () =>
      validateCustomSkillsForEditor(state.customSkills, {
        reservedNames: GRAFANA_SKILLS.map((skill) => skill.name),
      }),
    [state.customSkills]
  );
  const customSkillsError = useMemo(() => formatCustomSkillValidationIssues(customSkillIssues), [customSkillIssues]);
  const allowedUsers = useMemo(() => parseAllowedUsersInput(state.allowedUsersText), [state.allowedUsersText]);
  const allowedUsersError =
    state.accessMode === 'users' && allowedUsers.length === 0
      ? 'Enter at least one Grafana login or email.'
      : undefined;

  const isSubmitDisabled = Boolean(
    !state.openAIBaseUrl ||
    !state.defaultModel ||
    (!state.isOpenAIAPIKeySet && !state.openAIAPIKey) ||
    allowedUsersError ||
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

  const onChangeThinkingLevel = (thinkingLevel: PiAppThinkingLevel) => {
    setState({
      ...state,
      thinkingLevel,
    });
  };

  const onChangeThinkingFormat = (thinkingFormat: PiAppThinkingFormat) => {
    setState({
      ...state,
      thinkingFormat,
    });
  };

  const onChangeAccessMode = (accessMode: PiAppAccessMode) => {
    setState({
      ...state,
      accessMode,
    });
  };

  const onChangeAllowedUsers = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setState({
      ...state,
      allowedUsersText: event.currentTarget.value,
    });
  };

  const onChangeAllowedDatasourceUids = (options: Array<ComboboxOption<string>>) => {
    setState({
      ...state,
      allowedPrometheusDatasourceUids: options.map((option) => option.value),
    });
  };

  const onChangeSystemPromptAddendum = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setState({
      ...state,
      systemPromptAddendum: event.currentTarget.value,
    });
  };

  const onChangeCustomSkills = (customSkills: PiAppCustomSkill[]) => {
    setState({
      ...state,
      customSkills,
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const customSkills = serializeCustomSkills(state.customSkills);

    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        openAIBaseUrl: state.openAIBaseUrl,
        defaultModel: state.defaultModel,
        thinkingLevel: state.thinkingLevel,
        thinkingFormat: state.thinkingFormat,
        isOpenAIAPIKeySet: true,
        accessMode: state.accessMode,
        allowedUsers,
        allowedPrometheusDatasourceUids: state.allowedPrometheusDatasourceUids,
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
      <FieldSet label="Access" className={s.marginTopXl}>
        <Field
          label="Who can use the app"
          description={`RBAC mode checks the ${APP_ACCESS_ACTION} permission. The plugin role grants it to organization admins by default.`}
        >
          <RadioButtonGroup<PiAppAccessMode>
            options={accessModeOptions}
            value={state.accessMode}
            onChange={onChangeAccessMode}
          />
        </Field>

        {state.accessMode === 'users' && (
          <Field
            label="Allowed users"
            description="One Grafana login or email per line. Organization admins are always allowed."
            className={s.marginTop}
            invalid={Boolean(allowedUsersError)}
            error={allowedUsersError}
          >
            <TextArea
              className={s.allowedUsersTextArea}
              data-testid={testIds.appConfig.allowedUsers}
              id="allowed-users"
              rows={5}
              value={state.allowedUsersText}
              placeholder="alice@example.com"
              onChange={onChangeAllowedUsers}
            />
          </Field>
        )}
      </FieldSet>

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
          label="Thinking level"
          description="Optional reasoning effort for models that support it. Off preserves the current request shape."
          className={s.marginTop}
        >
          <div data-testid={testIds.appConfig.thinkingLevel}>
            <RadioButtonGroup<PiAppThinkingLevel>
              options={thinkingLevelOptions}
              value={state.thinkingLevel}
              onChange={onChangeThinkingLevel}
            />
          </div>
        </Field>

        <Field
          label="Thinking format"
          description="Provider-specific OpenAI-compatible request field used when thinking is enabled."
          className={s.marginTop}
        >
          <div data-testid={testIds.appConfig.thinkingFormat}>
            <RadioButtonGroup<PiAppThinkingFormat>
              options={thinkingFormatOptions}
              value={state.thinkingFormat}
              onChange={onChangeThinkingFormat}
            />
          </div>
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
      </FieldSet>

      <FieldSet label="Custom skills" className={s.marginTopXl}>
        <CustomSkillsEditor
          value={state.customSkills}
          issues={customSkillIssues}
          error={customSkillsError}
          onChange={onChangeCustomSkills}
        />
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
  allowedUsersTextArea: css`
    max-width: 640px;
    width: 100%;
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
});

const thinkingLevelOptions: Array<{ label: string; value: PiAppThinkingLevel; description: string }> = [
  { label: 'Off', value: 'off', description: 'Do not request model thinking.' },
  { label: 'Low', value: 'low', description: 'Small reasoning budget.' },
  { label: 'Medium', value: 'medium', description: 'Balanced reasoning budget.' },
  { label: 'High', value: 'high', description: 'Higher reasoning budget.' },
];

const thinkingFormatOptions: Array<{ label: string; value: PiAppThinkingFormat; description: string }> = [
  { label: 'OpenAI', value: 'openai', description: 'Send reasoning_effort.' },
  { label: 'Qwen', value: 'qwen', description: 'Send enable_thinking.' },
  { label: 'Qwen template', value: 'qwen-chat-template', description: 'Send chat_template_kwargs.enable_thinking.' },
];

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
