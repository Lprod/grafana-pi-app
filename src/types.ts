export type PiAppCustomSkillActivation = {
  keywords?: string[];
  regex?: string;
  explicitOnly?: boolean;
};

export type PiAppCustomSkillResource = {
  path?: string;
  content?: string;
};

export type PiAppCustomSkill = {
  name?: string;
  description?: string;
  content?: string;
  enabled?: boolean;
  activation?: PiAppCustomSkillActivation;
  toolGroups?: string[];
  resources?: PiAppCustomSkillResource[];
  disableModelInvocation?: boolean;
};

export type PiAppAccessMode = 'all' | 'admins' | 'users' | 'rbac';

export type PiAppJsonData = {
  openAIBaseUrl?: string;
  defaultModel?: string;
  isOpenAIAPIKeySet?: boolean;
  accessMode?: PiAppAccessMode;
  allowedUsers?: string[];
  allowedPrometheusDatasourceUids?: string[];
  // Legacy name kept for existing plugin settings.
  allowedDatasourceUids?: string[];
  allowedRqliteDatasourceUids?: string[];
  systemPromptAddendum?: string;
  customSkills?: PiAppCustomSkill[];
};
